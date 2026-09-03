/**
 * `foreman reconcile` — repairs Linear drift from a declarative invariant
 * table (simplification plan Phase 3). Replaces the reaper worker, the
 * abandoned/no-PR routing skips, and the merge-detect worker with one
 * idempotent pass: each invariant selects issues in a broken state and
 * fixes them, gated by the same `Confirmer` the loops use.
 */

import {
  all,
  BLOCKED_FILTER,
  branchNameFor,
  type Confirmer,
  encodeMarker,
  FOREMAN_LABEL,
  type GitHubClient,
  inInitiatives,
  inState,
  inStateType,
  type Issue,
  latestMarker,
  type LinearWriter,
  lockState,
  MARKER_KIND,
  type MergedRecord,
  readLockComment,
  type ResolvedRepoEntry,
  resolveState,
  RUNNING_FILTER,
  unlabeled,
} from "@foreman/core";

export interface ReconcileContext {
  linear: LinearWriter;
  github: GitHubClient;
  entry: ResolvedRepoEntry;
  now: Date;
  liveDispatchIds: Set<string>;
  lockTtlMs: number;
  confirmer: Confirmer;
}

export interface Invariant {
  name: string;
  select(ctx: ReconcileContext): Promise<Issue[]>;
  fix(issue: Issue, ctx: ReconcileContext): Promise<string>;
}

async function removeForemanLabel(linear: LinearWriter, issue: Issue, label: string): Promise<void> {
  const target = issue.labels.find((candidate) => candidate.name === label || candidate.id === label);
  if (!target) return;
  // Clears the assignee in the same mutation: `staleRunning` hands an
  // orphaned claim back from Foreman's own account, and `blockedAnswered`
  // hands a resolved block back from the operator's — both mean "nobody's
  // holding this anymore," so a fresh dispatch is free to claim it again.
  await linear.updateIssue(issue.id, { removedLabelIds: [target.id], assigneeId: null });
}

/** Whether `issue` is actually merged: PR mode checks `gh`, direct-branch mode trusts the latest `merged` marker or falls back to a branch-merge check. */
async function isIssueMerged(issue: Issue, ctx: ReconcileContext): Promise<boolean> {
  const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
  if (ctx.entry.pr.required) {
    const pr = await ctx.github.prForBranch(ctx.entry.repoPath, branch, {
      state: "all",
      base: ctx.entry.baseBranch,
    });
    return pr !== null && pr.baseBranch === ctx.entry.baseBranch && (await ctx.github.isMerged(ctx.entry.repoPath, pr.number));
  }

  const mergedMarker = latestMarker<MergedRecord>(MARKER_KIND.merged, issue.comments ?? []);
  if (mergedMarker && mergedMarker.data.branch === branch && mergedMarker.data.baseBranch === ctx.entry.baseBranch) {
    return true;
  }
  const mergedBranches = await ctx.github.mergedBranches(ctx.entry.repoPath, ctx.entry.baseBranch, [branch]);
  return mergedBranches.includes(branch);
}

const staleRunning: Invariant = {
  name: "stale-running",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), RUNNING_FILTER),
      includeComments: true,
    });
    return issues.filter((issue) => {
      const record = readLockComment(issue.comments ?? [])?.data ?? null;
      return lockState(record, { now: ctx.now, liveDispatchIds: [...ctx.liveDispatchIds] }).orphaned || record === null;
    });
  },
  async fix(issue, ctx) {
    await removeForemanLabel(ctx.linear, issue, FOREMAN_LABEL.running);
    if (issue.state.type === "started") {
      const states = await ctx.linear.workflowStates(issue.team.id);
      await ctx.linear.updateIssue(issue.id, { stateId: resolveState("todo", states).id });
    }
    const record = readLockComment(issue.comments ?? [])?.data ?? null;
    const summary = record
      ? `Foreman: released orphaned lock ${record.dispatchId} (taken ${record.takenAt}).`
      : `Foreman: removed \`${FOREMAN_LABEL.running}\` with no matching lock comment.`;
    await ctx.linear.createComment({ issueId: issue.id, body: summary });
    return `removed ${FOREMAN_LABEL.running}${issue.state.type === "started" ? "; moved to Todo" : ""}`;
  },
};

const inProgressAbandoned: Invariant = {
  name: "in-progress-abandoned",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), inStateType("started"), unlabeled()),
      includeComments: true,
    });
    return issues.filter((issue) => {
      const record = readLockComment(issue.comments ?? [])?.data ?? null;
      if (record === null) return true;
      const takenAt = new Date(record.takenAt).getTime();
      return !Number.isFinite(takenAt) || ctx.now.getTime() - takenAt > ctx.lockTtlMs;
    });
  },
  async fix(issue, ctx) {
    const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
    const pr = await ctx.github.prForBranch(ctx.entry.repoPath, branch);
    const states = await ctx.linear.workflowStates(issue.team.id);
    const target = pr !== null ? resolveState("inReview", states) : resolveState("todo", states);
    await ctx.linear.updateIssue(issue.id, { stateId: target.id });
    return `moved to ${target.name} (${pr !== null ? "open PR found" : "no PR found"})`;
  },
};

const mergedNotDone: Invariant = {
  name: "merged-not-done",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), inState("In Review")),
      includeComments: true,
    });
    const flags = await Promise.all(issues.map((issue) => isIssueMerged(issue, ctx)));
    return issues.filter((_, index) => flags[index]);
  },
  async fix(issue, ctx) {
    const states = await ctx.linear.workflowStates(issue.team.id);
    await ctx.linear.updateIssue(issue.id, { stateId: resolveState("done", states).id });
    return "moved to Done (merged)";
  },
};

const inReviewNoPr: Invariant = {
  name: "in-review-no-pr",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), inState("In Review"), unlabeled()),
    });
    const out: Issue[] = [];
    for (const issue of issues) {
      const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
      const pr = await ctx.github.prForBranch(ctx.entry.repoPath, branch);
      if (pr !== null) continue;
      const pushed = await branchPushed(ctx, branch);
      if (!pushed) out.push(issue);
    }
    return out;
  },
  async fix(issue, ctx) {
    const states = await ctx.linear.workflowStates(issue.team.id);
    await ctx.linear.updateIssue(issue.id, { stateId: resolveState("todo", states).id });
    return "moved to Todo (no PR, branch not pushed)";
  },
};

/** True when `origin/<branch>` resolves, via `GitHubClient.refExists`'s `git rev-parse --verify` probe. */
async function branchPushed(ctx: ReconcileContext, branch: string): Promise<boolean> {
  return ctx.github.refExists(ctx.entry.repoPath, `origin/${branch}`);
}

const blockedAnswered: Invariant = {
  name: "blocked-answered",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), BLOCKED_FILTER),
      includeComments: true,
    });
    return issues.filter((issue) => {
      const comments = issue.comments ?? [];
      const marker = latestMarker(MARKER_KIND.block, comments);
      if (!marker) return false;
      return comments.some(
        (comment) =>
          new Date(comment.createdAt).getTime() > new Date(marker.createdAt).getTime() &&
          comment.user?.id !== undefined &&
          findCommentAuthor(comments, marker.commentId) !== comment.user?.id,
      );
    });
  },
  async fix(issue, ctx) {
    await removeForemanLabel(ctx.linear, issue, FOREMAN_LABEL.blocked);
    const comments = issue.comments ?? [];
    const marker = latestMarker(MARKER_KIND.block, comments);
    const answeringComment = comments
      .filter(
        (comment) =>
          marker !== null && new Date(comment.createdAt).getTime() > new Date(marker.createdAt).getTime(),
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const body = encodeMarker(
      MARKER_KIND.unblock,
      {},
      `auto: answered in comment ${answeringComment?.id ?? "unknown"}`,
    );
    await ctx.linear.createComment({ issueId: issue.id, body });
    return `removed ${FOREMAN_LABEL.blocked}`;
  },
};

function findCommentAuthor(comments: readonly { id: string; user: { id: string } | null }[], commentId: string): string | null {
  return comments.find((comment) => comment.id === commentId)?.user?.id ?? null;
}

export const INVARIANTS: Invariant[] = [
  staleRunning,
  inProgressAbandoned,
  mergedNotDone,
  inReviewNoPr,
  blockedAnswered,
];

export async function reconcile(
  ctx: ReconcileContext,
  opts: { dryRun: boolean; log: (line: string) => void },
): Promise<{ fixed: number; skipped: number }> {
  let fixed = 0;
  let skipped = 0;
  for (const invariant of INVARIANTS) {
    const issues = await invariant.select(ctx);
    for (const issue of issues) {
      const summary = `${invariant.name} ${issue.identifier}`;
      if (opts.dryRun) {
        opts.log(`${summary}: would fix (dry run)`);
        continue;
      }
      const approved = await ctx.confirmer.confirm({ kind: `reconcile-${invariant.name}`, summary });
      if (!approved) {
        opts.log(`${summary}: skipped (declined)`);
        skipped += 1;
        continue;
      }
      const detail = await invariant.fix(issue, ctx);
      opts.log(`${summary}: ${detail}`);
      fixed += 1;
    }
  }
  return { fixed, skipped };
}
