/**
 * Review worker (SPEC §17.5): selects PRs (or, in direct-branch mode,
 * pushed branches) whose head SHA has no `ReviewResult` marker yet.
 */

import {
  BLOCKED_HUMAN_FILTER,
  GitHubClient,
  MARKER_KIND,
  branchNameFor,
  expandHome,
  inState,
  latestMarker,
  newDispatchId,
  nodeRunner,
  repoForIssue,
  resolveRepoConfig,
} from "@foreman/core";
import type { BoardSnapshot, ReviewCandidate } from "../routing.ts";
import { nextActions } from "../routing.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function buildReviewCandidates(
  ctx: WorkerContext,
  github: GitHubClient,
  skipped: WorkerReport["skipped"],
): Promise<ReviewCandidate[]> {
  const inReview = await ctx.linear.issues({
    filter: inState("In Review"),
    limit: 500,
    includeComments: true,
  });

  const candidates: ReviewCandidate[] = [];
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

    let prOpen = false;
    let headSha = "";
    if (repoSettings.pr.required) {
      const pr = await github.prForBranch(repoPath, branch);
      if (!pr) continue;
      prOpen = pr.state === "OPEN";
      headSha = pr.headSha;
    } else {
      // Direct-branch mode: the pushed branch itself is the review target
      // (SPEC §3.10), so its presence stands in for "PR open".
      try {
        const { stdout } = await nodeRunner.run(
          ["git", "rev-parse", `origin/${branch}`],
          { cwd: repoPath },
        );
        headSha = stdout.trim();
        prOpen = headSha.length > 0;
      } catch {
        continue;
      }
    }
    if (!headSha) continue;
    const review = latestMarker<{ headSha: string }>(MARKER_KIND.review, issue.comments);
    const hasReviewForHead = review?.data.headSha === headSha;

    candidates.push({ issue, prOpen, headSha, hasReviewForHead });
  }
  return candidates;
}

async function runReview(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const github = new GitHubClient();

  const candidateSkips: WorkerReport["skipped"] = [];
  const [reviewCandidates, blockedHuman] = await Promise.all([
    buildReviewCandidates(ctx, github, candidateSkips),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
  ]);

  const snapshot: BoardSnapshot = {
    inbox: [],
    backlog: [],
    todo: [],
    reviewCandidates,
    blockedHumanCount: blockedHuman.length,
    proposedCount: 0,
    readyBufferCount: 0,
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping, now);
  skipped.push(...candidateSkips);

  if (!ctx.dryRun) {
    for (const decision of decisions) {
      if (!decision.issueId) continue;
      const candidate = reviewCandidates.find((c) => c.issue.identifier === decision.issueId);
      if (!candidate) continue;
      let cwd: string;
      if (candidate.issue.project === null) {
        cwd = `${expandHome(ctx.config.loop.stateDir)}/scratch`;
      } else {
        try {
          cwd = await repoForIssue({ linear: ctx.linear, config: ctx.config }, candidate.issue);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            stage: "review",
            issueId: decision.issueId,
            code: "unresolved-repo",
            message,
          });
          continue;
        }
      }

      const dispatchId = newDispatchId(decision.agent, decision.issueId, now);
      try {
        const handle = await ctx.dispatcher.dispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          command: decision.command,
          dispatchId,
          cwd,
        });
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "review",
        });
        if (candidate) ctx.bookkeeping.setReviewedSha(decision.issueId, candidate.headSha);
      } catch (error) {
        errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
      }
    }
  }

  ctx.bookkeeping.setLastRun("review", now);
  return { worker: "review", ranAt: now.toISOString(), dispatched: decisions, skipped, errors };
}

export const reviewWorker: Worker = {
  name: "review",
  cadenceMs: 5 * 60_000,
  run: runReview,
};
