/**
 * Merge-detection worker (SPEC §16 item 7, §3.10). Linear's GitHub
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
  repoForIssue,
  resolveRepoConfig,
  resolveState,
} from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function runMergeDetect(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const skipped: WorkerReport["skipped"] = [];

  if (!ctx.config.loop.mergeDetection) {
    return { worker: "merge-detect", ranAt: now.toISOString(), dispatched: [], skipped, errors };
  }

  const github = new GitHubClient();
  const inReview = await ctx.linear.issues({ filter: inState("In Review"), limit: 500 });

  for (const issue of inReview) {
    if (!issue.project) continue;
    let repoPath: string;
    try {
      repoPath = await repoForIssue({ linear: ctx.linear, config: ctx.config }, issue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({
        stage: "review",
        issueId: issue.identifier,
        code: "unresolved-repo",
        message,
      });
      continue;
    }
    const repoSettings = resolveRepoConfig(ctx.config, repoPath);
    const branch = branchNameFor(repoSettings.branchPattern, issue);

    let merged = false;
    try {
      if (repoSettings.pr.required) {
        const pr = await github.prForBranch(repoPath, branch);
        merged = pr ? await github.isMerged(repoPath, pr.number) : false;
      } else {
        const mergedBranches = await github.mergedBranches(repoPath, repoSettings.baseBranch, [branch]);
        merged = mergedBranches.includes(branch);
      }
    } catch (error) {
      errors.push(`merge check failed for ${issue.identifier}: ${String(error)}`);
      continue;
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

    if (ctx.dryRun) {
      skipped.push({
        stage: "review",
        issueId: issue.identifier,
        code: "dry-run-merge-detected",
        message: "Would move to Done: merge detected.",
      });
      continue;
    }

    const states = await ctx.linear.workflowStates(issue.team.id);
    const done = resolveState("done", states);
    await ctx.linear.updateIssue(issue.id, { stateId: done.id });
  }

  return { worker: "merge-detect", ranAt: now.toISOString(), dispatched: [], skipped, errors };
}

export const mergeDetectWorker: Worker = {
  name: "merge-detect",
  cadenceMs: 5 * 60_000,
  run: runMergeDetect,
};
