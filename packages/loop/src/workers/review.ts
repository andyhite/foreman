/**
 * Review worker (SPEC §17.5): selects PRs (or, in direct-branch mode,
 * pushed branches) whose head SHA has no `ReviewResult` marker yet, scoped
 * to this instance (SPEC §3.11).
 */

import type { ReviewResult } from "@foreman/core";
import {
  BLOCKED_HUMAN_FILTER,
  DISPATCH_COMMAND,
  GitHubClient,
  MARKER_KIND,
  branchNameFor,
  inState,
  latestMarker,
  newDispatchId,
  nodeRunner,
  type DispatchItem,
} from "@foreman/core";
import { isOrchestratorBusy } from "../dispatch/index.ts";
import type { BoardSnapshot, DispatchDecision, ReviewCandidate } from "../routing.ts";
import { nextActions } from "../routing.ts";
import { toQueueItem } from "../snapshot.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";
import { filterInScope } from "./types.ts";
import { applyPendingDecisions } from "./decisions.ts";

async function buildReviewCandidates(
  ctx: WorkerContext,
  github: GitHubClient,
  skipped: WorkerReport["skipped"],
): Promise<ReviewCandidate[]> {
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
  const { inScope: inReview, skipped: scopeSkips } = await filterInScope(ctx, "review", inReviewIssues);
  skipped.push(...scopeSkips);

  const repoPath = ctx.entry.repoPath;
  const candidates: ReviewCandidate[] = [];
  for (const issue of inReview) {
    const branch = branchNameFor(ctx.entry.branchPattern, issue, repoPath);

    let prOpen = false;
    let headSha = "";
    if (ctx.entry.pr.required) {
      try {
        const pr = await github.prForBranch(repoPath, branch);
        if (!pr) {
          skipped.push({ stage: "review", issueId: issue.identifier, code: "pr-not-open", message: "No open PR for this issue." });
          continue;
        }
        prOpen = pr.state === "OPEN";
        headSha = pr.headSha;
      } catch (error) {
        skipped.push({ stage: "review", issueId: issue.identifier, code: "pr-not-open", message: `PR lookup failed: ${String(error)}` });
        continue;
      }
    } else {
      try {
        const { stdout } = await nodeRunner.run(
          ["git", "rev-parse", `origin/${branch}`],
          { cwd: repoPath },
        );
        headSha = stdout.trim();
        prOpen = headSha.length > 0;
      } catch (error) {
        skipped.push({
          stage: "review",
          issueId: issue.identifier,
          code: "head-sha-unavailable",
          message: String(error),
        });
        continue;
      }
    }
    if (!headSha) {
      skipped.push({ stage: "review", issueId: issue.identifier, code: "pr-not-open", message: "PR has no head SHA." });
      continue;
    }
    // Authorship unverifiable: fail closed by treating the review marker as
    // absent, so a forged clean review can never satisfy the merge gate.
    const review =
      viewerId === null
        ? null
        : latestMarker<ReviewResult>(MARKER_KIND.review, issue.comments, { authoredBy: viewerId });
    const hasReviewForHead = review?.data.reviewedSha === headSha;

    candidates.push({ issue, prOpen, headSha, hasReviewForHead });
  }
  return candidates;
}

async function runReview(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const dispatched: DispatchDecision[] = [];
  const github = new GitHubClient();

  const candidateSkips: WorkerReport["skipped"] = [];
  const [reviewCandidates, blockedHuman] = await Promise.all([
    buildReviewCandidates(ctx, github, candidateSkips),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
  ]);

  const snapshot: BoardSnapshot = {
    backlog: [],
    todo: [],
    reviewCandidates,
    blockedHumanCount: blockedHuman.length,
    readyBufferCount: 0,
    planCandidates: [],
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping);
  skipped.push(...candidateSkips);

  const confirmed: Array<{ decision: DispatchDecision; candidate: ReviewCandidate; issueId: string }> = [];
  for (const decision of decisions) {
    if (!decision.issueId) continue;
    const issueId = decision.issueId;
    const candidate = reviewCandidates.find((c) => c.issue.identifier === issueId);
    if (!candidate) continue;

    const summary = `dispatch ${decision.agent} for ${issueId}`;
    if (!(await ctx.confirm({ kind: "dispatch", summary, detail: [`command: ${decision.command}`, `cwd: ${ctx.entry.repoPath}`] }))) {
      skipped.push({ stage: "review", issueId, code: "dispatch-declined", message: `Operator declined: ${summary}` });
      continue;
    }
    confirmed.push({ decision, candidate, issueId });
  }

  if (confirmed.length > 0) {
    const items: DispatchItem[] = confirmed.map(({ decision }) => ({
      issueId: decision.issueId,
      subject: decision.subject,
      dispatchId: newDispatchId(decision.agent, decision.subject ?? "batch", now),
      worktree: null,
    }));
    try {
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-review",
        command: DISPATCH_COMMAND.review,
        cwd: ctx.entry.repoPath,
        alias: ctx.entry.alias,
        items,
      });
      for (const [index, handle] of handles.entries()) {
        const entry = confirmed[index];
        if (!entry) continue;
        const { decision, candidate, issueId } = entry;
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "review",
        });
        dispatched.push(decision);
        const previousSha = ctx.bookkeeping.reviewedSha(issueId);
        if (previousSha !== null && previousSha !== candidate.headSha) {
          const pending = ctx.bookkeeping.recordReviewCycle(issueId, ctx.config.loop.reviewCycleCap, now);
          if (pending) {
            errors.push(...(await applyPendingDecisions(ctx, [pending])));
            ctx.bookkeeping.drainPendingDecisions();
            continue;
          }
        }
        ctx.bookkeeping.setReviewedSha(issueId, candidate.headSha);
      }
      ctx.watchSettle(handles, "review");
    } catch (error) {
      if (isOrchestratorBusy(error)) {
        for (const { decision } of confirmed) {
          skipped.push({
            stage: "review",
            issueId: decision.issueId,
            code: "orchestrator-busy",
            message: `foreman-review orchestrator is busy: ${error.message}`,
          });
        }
      } else {
        errors.push(`dispatch ${DISPATCH_COMMAND.review} failed: ${String(error)}`);
      }
    }
  }

  ctx.bookkeeping.setLastRun("review", now);
  return {
    worker: "review",
    ranAt: now.toISOString(),
    decisions,
    dispatched,
    skipped,
    errors,
    counts: { inReview: reviewCandidates.length, blocked: blockedHuman.length },
    queues: { pipeline: reviewCandidates.map((candidate) => toQueueItem(candidate.issue)) },
  };
}

export const reviewWorker: Worker = {
  name: "review",
  cadenceMs: 5 * 60_000,
  run: runReview,
};
