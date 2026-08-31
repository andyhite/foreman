/**
 * Merge-detection worker (SPEC §16 item 7, §3.10, §3.11). Linear's GitHub
 * integration only auto-transitions to Done when a team workflow automation
 * has been configured, and in direct-branch mode (`pr.required: false`)
 * there is no PR event at all — so this worker is required, not optional
 * polish. It never merges anything itself (SPEC §19: merge authority never
 * enters the loop); it only notices a merge that already happened and moves
 * the issue to Done.
 */

import {
  GitHubClient,
  branchNameFor,
  inState,
  latestMarker,
  MARKER_KIND,
  resolveState,
  type MergedRecord,
} from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";
import { filterInScope } from "./types.ts";

async function runMergeDetect(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const skipped: WorkerReport["skipped"] = [];

  if (!ctx.config.loop.mergeDetection) {
    ctx.log(
      "merge detection disabled (loop.mergeDetection=false); merged PRs will not move to Done.",
    );
    return { worker: "merge-detect", ranAt: now.toISOString(), decisions: [], dispatched: [], skipped, errors };
  }

  const github = new GitHubClient();
  let viewerId: string | null;
  try {
    viewerId = await ctx.linear.viewerId();
  } catch {
    viewerId = null;
  }
  const inReviewIssues = await ctx.linear.issues({
    filter: inState("In Review"),
    limit: 500,
    includeComments: true,
  });
  if (inReviewIssues.length >= 500) {
    ctx.log(`merge-detect: query returned a full page of 500 In Review issues; some may not have been checked this pass.`);
  }
  const { inScope: inReview, skipped: scopeSkips } = await filterInScope(ctx, "review", inReviewIssues);
  skipped.push(...scopeSkips);

  const repoPath = ctx.entry.repoPath;
  for (const issue of inReview) {
    const branch = branchNameFor(ctx.entry.branchPattern, issue, repoPath);
    try {
      let merged = false;
      if (ctx.entry.pr.required) {
        const pr = await github.prForBranch(repoPath, branch, { state: "all", base: ctx.entry.baseBranch });
        merged = pr !== null && pr.baseBranch === ctx.entry.baseBranch && (await github.isMerged(repoPath, pr.number));
      } else {
        const mergedMarker =
          viewerId !== null
            ? latestMarker<MergedRecord>(MARKER_KIND.merged, issue.comments, { authoredBy: viewerId })
            : null;
        if (mergedMarker && mergedMarker.data.branch === branch && mergedMarker.data.baseBranch === ctx.entry.baseBranch) {
          merged = true;
        } else {
          const mergedBranches = await github.mergedBranches(repoPath, ctx.entry.baseBranch, [branch]);
          merged = mergedBranches.includes(branch);
        }
      }

      if (!merged) {
        skipped.push({
          stage: "review",
          issueId: issue.identifier,
          code: "not-merged",
          message: "Branch/PR not yet merged.",
        });
        continue;
      }

      if (ctx.dryRun || ctx.config.loop.stage === "read-only") {
        skipped.push({
          stage: "review",
          issueId: issue.identifier,
          code: ctx.dryRun ? "dry-run-merge-detected" : "read-only-merge-detected",
          message: "Merge detected; would move to Done outside read-only mode.",
        });
        continue;
      }

      const states = await ctx.linear.workflowStates(issue.team.id);
      const done = resolveState("done", states);
      await ctx.linear.updateIssue(issue.id, { stateId: done.id });
      ctx.bookkeeping.resetReviewCycles(issue.identifier);
    } catch (error) {
      errors.push(`merge check/transition failed for ${issue.identifier}: ${String(error)}`);
    }
  }

  return { worker: "merge-detect", ranAt: now.toISOString(), decisions: [], dispatched: [], skipped, errors };
}

export const mergeDetectWorker: Worker = {
  name: "merge-detect",
  cadenceMs: 5 * 60_000,
  run: runMergeDetect,
};
