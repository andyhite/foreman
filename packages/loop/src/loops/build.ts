/**
 * `foreman build` — implement, review, merge (simplification plan Phase 4).
 * Every Todo issue with an implementation-ready gate becomes an `implement`
 * candidate; every In Review issue not yet reviewed at its current head
 * becomes a `review` candidate; every In Review issue reviewed-and-approved
 * at head becomes a `merge` candidate.
 *
 * `Rule.select(snapshot)` takes no `LoopContext` (SPEC-fixed shape), so
 * everything a candidate needs from `ctx` — `cwd`, the worktree path — is
 * computed once in `fetch` and carried on the snapshot's per-issue entries.
 */

import {
  all,
  branchNameFor,
  DISPATCH_COMMAND,
  implementationGate,
  inInitiatives,
  inState,
  inStateType,
  type Issue,
  latestMarker,
  MARKER_KIND,
  notInTerminalProject,
  priorityRank,
  type ReviewResult,
  unlabeled,
  worktreePathFor,
} from "@foreman/core";
import type { Candidate, Loop, Rule } from "../engine.ts";

function byPriorityThenAge(a: Issue, b: Issue): number {
  const rankDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (rankDiff !== 0) return rankDiff;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

interface TodoEntry {
  issue: Issue;
  cwd: string;
  worktreePath: string;
}

interface ReviewEntry {
  issue: Issue;
  cwd: string;
  prOpen: boolean;
  mergeable: boolean | null;
  headSha: string;
  latestReview: { data: ReviewResult; commentId: string } | null;
}

export interface BuildSnapshot {
  todo: TodoEntry[];
  inReview: ReviewEntry[];
}

const implementRule: Rule<BuildSnapshot> = {
  name: "implement",
  select(snapshot) {
    const eligible = snapshot.todo
      .filter((entry) => entry.issue.assignee === null && implementationGate(entry.issue).ok)
      .sort((a, b) => byPriorityThenAge(a.issue, b.issue));
    return eligible.map(
      (entry): Candidate => ({
        key: `issue:${entry.issue.identifier}`,
        agent: "foreman-implement",
        command: DISPATCH_COMMAND.implement,
        subject: entry.issue.identifier,
        cwd: entry.cwd,
        worktree: entry.worktreePath,
        reason: `dispatch foreman-implement for ${entry.issue.identifier}`,
      }),
    );
  },
};

const reviewRule: Rule<BuildSnapshot> = {
  name: "review",
  select(snapshot) {
    const eligible = snapshot.inReview
      .filter((entry) => entry.prOpen && entry.headSha !== "" && entry.latestReview?.data.reviewedSha !== entry.headSha)
      .sort((a, b) => byPriorityThenAge(a.issue, b.issue));
    return eligible.map(
      (entry): Candidate => ({
        key: `issue:${entry.issue.identifier}`,
        agent: "foreman-review",
        command: DISPATCH_COMMAND.review,
        subject: entry.issue.identifier,
        cwd: entry.cwd,
        worktree: null,
        reason: `dispatch foreman-review for ${entry.issue.identifier}`,
      }),
    );
  },
};

const mergeRule: Rule<BuildSnapshot> = {
  name: "merge",
  select(snapshot) {
    const eligible = snapshot.inReview
      .filter(
        (entry) =>
          entry.headSha !== "" &&
          entry.latestReview?.data.reviewedSha === entry.headSha &&
          entry.latestReview.data.verdict === "approve" &&
          entry.mergeable !== false,
      )
      .sort((a, b) => byPriorityThenAge(a.issue, b.issue));
    return eligible.map(
      (entry): Candidate => ({
        key: `issue:${entry.issue.identifier}`,
        agent: "foreman-merge",
        command: DISPATCH_COMMAND.merge,
        subject: entry.issue.identifier,
        cwd: entry.cwd,
        worktree: null,
        reason: `dispatch /foreman:merge for ${entry.issue.identifier}`,
      }),
    );
  },
};

export const BUILD_LOOP: Loop<BuildSnapshot> = {
  name: "build",
  concurrency: 3,
  async fetch(ctx) {
    const todoIssues = await ctx.linear.issues({
      filter: all(
        inInitiatives(ctx.entry.initiativeIds),
        inStateType("unstarted"),
        unlabeled(),
        notInTerminalProject(),
      ),
    });
    const todo: TodoEntry[] = todoIssues.map((issue) => ({
      issue,
      cwd: ctx.entry.repoPath,
      worktreePath: worktreePathFor(ctx.entry.worktreePattern, ctx.entry.repoPath, issue),
    }));

    const inReviewIssues = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), inState("In Review"), unlabeled()),
      includeComments: true,
    });
    const inReview: ReviewEntry[] = [];
    for (const issue of inReviewIssues) {
      const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
      // eslint-disable-next-line no-await-in-loop -- one GitHub read per In Review issue; this loop's own poll cadence bounds the cost.
      const pr = ctx.entry.pr.required
        ? await ctx.github.prForBranch(ctx.entry.repoPath, branch, { state: "open" })
        : null;
      // eslint-disable-next-line no-await-in-loop
      const branchPushed = ctx.entry.pr.required ? false : await ctx.github.refExists(ctx.entry.repoPath, `origin/${branch}`);
      const headSha = pr?.headSha ?? (branchPushed ? branch : "");
      const latestReview = latestMarker<ReviewResult>(MARKER_KIND.review, issue.comments ?? []);
      inReview.push({
        issue,
        cwd: ctx.entry.repoPath,
        prOpen: ctx.entry.pr.required ? pr !== null : branchPushed,
        mergeable: pr?.mergeable ?? null,
        headSha,
        latestReview,
      });
    }

    return { todo, inReview };
  },
  rules: [implementRule, reviewRule, mergeRule],
};
