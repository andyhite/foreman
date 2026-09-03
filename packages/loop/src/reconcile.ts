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
  DENY_CONFIRMER,
  type Dispatcher,
  encodeMarker,
  ensureMaintenanceProjects,
  FOREMAN_LABEL,
  type GitHubClient,
  type GlobalConfig,
  inInitiatives,
  inState,
  type Issue,
  latestMarker,
  type LinearWriter,
  lockState,
  MARKER_KIND,
  type MergedRecord,
  nextProjectStatus,
  readLockComment,
  type ResolvedRepoEntry,
  resolveState,
  RUNNING_FILTER,
  unlabeled,
  type WorkflowStateType,
  cleanupMergedWork,
} from "@foreman/core";

export interface ReconcileContext {
  linear: LinearWriter;
  github: GitHubClient;
  entry: ResolvedRepoEntry;
  now: Date;
  liveDispatchIds: Set<string>;
  lockTtlMs: number;
  confirmer: Confirmer;
  viewerId: string | null;
  config: GlobalConfig;
  dispatcher?: Dispatcher;
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

/** Whether `issue` is actually merged: PR mode checks `gh`, direct-branch mode trusts the latest `merged` marker (when its authorship can be verified) or falls back to a branch-merge check. */
async function isIssueMerged(issue: Issue, ctx: ReconcileContext): Promise<boolean> {
  const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
  if (ctx.entry.pr.required) {
    const pr = await ctx.github.prForBranch(ctx.entry.repoPath, branch, {
      state: "all",
      base: ctx.entry.baseBranch,
    });
    return pr !== null && pr.baseBranch === ctx.entry.baseBranch && (await ctx.github.isMerged(ctx.entry.repoPath, pr.number));
  }

  if (ctx.viewerId !== null) {
    const mergedMarker = latestMarker<MergedRecord>(MARKER_KIND.merged, issue.comments ?? [], { authoredBy: ctx.viewerId });
    if (mergedMarker && mergedMarker.data.branch === branch && mergedMarker.data.baseBranch === ctx.entry.baseBranch) {
      return true;
    }
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
      const record = readLockComment(issue.comments ?? [], ctx.viewerId ?? undefined)?.data ?? null;
      return lockState(record, { now: ctx.now, liveDispatchIds: [...ctx.liveDispatchIds] }).orphaned || record === null;
    });
  },
  async fix(issue, ctx) {
    await removeForemanLabel(ctx.linear, issue, FOREMAN_LABEL.running);
    if (issue.state.type === "started") {
      const states = await ctx.linear.workflowStates(issue.team.id);
      await ctx.linear.updateIssue(issue.id, { stateId: resolveState("todo", states).id });
    }
    const record = readLockComment(issue.comments ?? [], ctx.viewerId ?? undefined)?.data ?? null;
    const summary = record
      ? `Foreman: released orphaned lock ${record.dispatchId} (taken ${record.takenAt}). Worktree ${record.worktree ?? "none"} left standing for inspection — reconcile never deletes it.`
      : `Foreman: removed \`${FOREMAN_LABEL.running}\` with no matching lock comment.`;
    await ctx.linear.createComment({ issueId: issue.id, body: summary });
    return `removed ${FOREMAN_LABEL.running}${issue.state.type === "started" ? "; moved to Todo" : ""}`;
  },
};

const inProgressAbandoned: Invariant = {
  name: "in-progress-abandoned",
  async select(ctx) {
    const issues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), inState("In Progress"), unlabeled()),
      includeComments: true,
    });
    return issues.filter((issue) => {
      const found = readLockComment(issue.comments ?? [], ctx.viewerId ?? undefined);
      const record = found?.data ?? null;
      if (record === null) return ctx.now.getTime() - new Date(issue.updatedAt).getTime() > 60_000;
      return lockState(record, { now: ctx.now, liveDispatchIds: [...ctx.liveDispatchIds] }).orphaned;
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
      first: 250,
    });
    const out: Issue[] = [];
    for (const issue of issues) {
      const merged = await isIssueMerged(issue, ctx);
      if (merged) out.push(issue);
    }
    return out;
  },
  async fix(issue, ctx) {
    const states = await ctx.linear.workflowStates(issue.team.id);
    await ctx.linear.updateIssue(issue.id, { stateId: resolveState("done", states).id });
    if (!ctx.config.loop.cleanupMergedWorktrees) return "moved to Done (merged)";
    const notes = await cleanupMergedWork({
      repoPath: ctx.entry.repoPath,
      worktreePattern: ctx.entry.worktreePattern,
      baseBranch: ctx.entry.baseBranch,
      issue: { identifier: issue.identifier, title: issue.title },
      dispatcher: ctx.dispatcher,
    });
    return `moved to Done (merged)${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
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

/** SPEC §7.6a: advance a project's native status to `started`/`completed` from its issues' state types. `paused`/`canceled` are the operator's and never advanced. */
async function reconcileProjectStatus(
  ctx: ReconcileContext,
  opts: { dryRun: boolean; log: (line: string) => void },
): Promise<{ fixed: number; skipped: number }> {
  let fixed = 0;
  let skipped = 0;
  const issues = await ctx.linear.issues({ filter: inInitiatives(ctx.entry.initiativeIds), first: 250 });
  const byProject = new Map<string, WorkflowStateType[]>();
  for (const issue of issues) {
    if (!issue.project) continue;
    const types = byProject.get(issue.project.id) ?? [];
    types.push(issue.state.type);
    byProject.set(issue.project.id, types);
  }
  for (const initiativeId of ctx.entry.initiativeIds) {
    for (const project of await ctx.linear.initiativeProjects(initiativeId)) {
      const current = project.status?.type;
      if (!current) continue;
      const next = nextProjectStatus(current, byProject.get(project.id) ?? []);
      if (next === null) continue;
      const summary = `project-status ${project.name}: ${current} → ${next}`;
      if (opts.dryRun) {
        opts.log(`${summary}: would fix (dry run)`);
        continue;
      }
      if (!(await ctx.confirmer.confirm({ kind: "reconcile-project-status", summary }))) {
        opts.log(`${summary}: skipped (declined)`);
        skipped += 1;
        continue;
      }
      try {
        await ctx.linear.updateProjectStatus({ projectId: project.id, type: next });
        opts.log(summary);
        fixed += 1;
      } catch (error) {
        opts.log(`${summary}: failed (${error instanceof Error ? error.message : String(error)})`);
        skipped += 1;
      }
    }
  }
  return { fixed, skipped };
}

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
      try {
        const detail = await invariant.fix(issue, ctx);
        opts.log(`${summary}: ${detail}`);
        fixed += 1;
      } catch (error) {
        opts.log(`${summary}: failed (${error instanceof Error ? error.message : String(error)})`);
        skipped += 1;
      }
    }
  }

  const statusResult = await reconcileProjectStatus(ctx, opts);
  fixed += statusResult.fixed;
  skipped += statusResult.skipped;

  const teams = await ctx.linear.teams();
  const team = ctx.entry.team !== null ? teams.find((candidate) => candidate.key === ctx.entry.team) : teams[0];
  if (team) {
    for (const report of await ensureMaintenanceProjects(ctx.linear, {
      initiativeIds: ctx.entry.initiativeIds,
      teamId: team.id,
      confirmer: opts.dryRun ? DENY_CONFIRMER : ctx.confirmer,
    })) {
      if (report.created) opts.log(`maintenance ${report.initiativeName}: created project ${report.projectId}`);
    }
  } else {
    opts.log(`maintenance: skipped, could not resolve team "${ctx.entry.team ?? "(sole accessible)"}"`);
    skipped += 1;
  }

  return { fixed, skipped };
}
