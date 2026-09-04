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
  findMarkers,
  implementationGate,
  inState,
  isHandsOff,
  type Issue,
  latestMarker,
  MARKER_KIND,
  notHandsOff,
  notInTerminalProject,
  reviewGate,
  type CiState,
  type ReviewResult,
  FOREMAN_STATE,
  worktreePathFor,
} from "@foreman/core";
import { byPriorityThenAge, type Candidate, type Escalation, type Loop, type Rule } from "../engine.ts";

interface ReadyEntry {
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
  requestChangesCycles: number;
  ciStatus: CiState;
}

export interface BuildSnapshot {
  ready: ReadyEntry[];
  inReview: ReviewEntry[];
  autoMerge: boolean;
  ciRequired: boolean;
  prRequired: boolean;
  reviewCycleCap: number;
  /** Null when the credential's viewer id could not be resolved; every candidate is then excluded (fails closed, matching `checkLockFree`). */
  viewerId: string | null;
}

const implementRule: Rule<BuildSnapshot> = {
  name: "implement",
  select(snapshot) {
    if (snapshot.viewerId === null) return [];
    const viewerId = snapshot.viewerId;
    const eligible = snapshot.ready
      .filter((entry) => !isHandsOff(entry.issue, viewerId) && implementationGate(entry.issue, viewerId).ok)
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
    if (snapshot.viewerId === null) return [];
    const eligible = snapshot.inReview
      .filter(
        (entry) =>
          entry.prOpen &&
          entry.headSha !== "" &&
          entry.latestReview?.data.reviewedSha !== entry.headSha &&
          entry.requestChangesCycles < snapshot.reviewCycleCap,
      )
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

/**
 * Gated on `loop.autoMerge` (SPEC §17.5, decision 1) and brought to
 * `reviewGate` parity by calling it directly rather than re-deriving its
 * checks: a refused `/foreman:merge` exits 0, so a weaker precondition here
 * would re-spawn a refused merge every poll forever with no back-off.
 */
const mergeRule: Rule<BuildSnapshot> = {
  name: "merge",
  select(snapshot) {
    if (snapshot.viewerId === null) return [];
    if (!snapshot.autoMerge) return [];
    const eligible = snapshot.inReview
      .filter((entry) => {
        if (entry.mergeable === false) return false;
        const gate = reviewGate({
          issue: entry.issue,
          review: entry.latestReview?.data ?? null,
          headSha: entry.headSha !== "" ? entry.headSha : null,
          ciStatus: entry.ciStatus,
          prOpen: entry.prOpen,
          prRequired: snapshot.prRequired,
          ciRequired: snapshot.ciRequired,
        });
        return gate.ok;
      })
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
    let viewerId: string | null;
    try {
      viewerId = await ctx.linear.viewerId();
    } catch {
      viewerId = null;
    }

    const readyIssues = await ctx.linear.issues({
      filter: all(
        inState(FOREMAN_STATE.ready),
        notHandsOff(viewerId ?? ""),
        notInTerminalProject(),
      ),
    });
    const ready: ReadyEntry[] = readyIssues.map((issue) => ({
      issue,
      cwd: ctx.entry.repoPath,
      worktreePath: worktreePathFor(ctx.entry.worktreePattern, ctx.entry.repoPath, issue),
    }));
    const inReviewIssues = await ctx.linear.issues({
      filter: all(inState(FOREMAN_STATE.inReview), notHandsOff(viewerId ?? "")),
      includeComments: true,
    });
    const inReview: ReviewEntry[] = [];
    for (const issue of inReviewIssues) {
      const branch = branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath);
      let pr = null;
      let branchSha: string | null = null;
      try {
        // eslint-disable-next-line no-await-in-loop -- one GitHub read per In Review issue; this loop's own poll cadence bounds the cost.
        pr = ctx.entry.pr.required
          ? await ctx.github.prForBranch(ctx.entry.repoPath, branch, { state: "open", base: ctx.entry.baseBranch })
          : null;
        // eslint-disable-next-line no-await-in-loop
        branchSha = ctx.entry.pr.required ? null : await ctx.github.revParse(ctx.entry.repoPath, `origin/${branch}`);
      } catch {
        pr = null;
        branchSha = null;
      }
      const headSha = pr?.headSha ?? branchSha ?? "";
      const prOpen = ctx.entry.pr.required ? pr !== null : branchSha !== null;

      const latestReview =
        viewerId === null
          ? null
          : latestMarker<ReviewResult>(MARKER_KIND.review, issue.comments ?? [], { authoredBy: viewerId });
      const requestChangesCycles =
        viewerId === null
          ? 0
          : findMarkers<ReviewResult>(MARKER_KIND.review, issue.comments ?? [], { authoredBy: viewerId }).filter(
              (found) => found.data.verdict === "request-changes",
            ).length;

      let ciStatus: CiState = "none";
      if (ctx.entry.pr.required && ctx.entry.pr.ciRequired && headSha !== "") {
        try {
          // eslint-disable-next-line no-await-in-loop
          ciStatus = await ctx.github.ciStatus(ctx.entry.repoPath, headSha);
        } catch {
          ciStatus = "none";
        }
      }

      inReview.push({
        issue,
        cwd: ctx.entry.repoPath,
        prOpen,
        mergeable: pr?.mergeable ?? null,
        headSha,
        latestReview,
        requestChangesCycles,
        ciStatus,
      });
    }

    return {
      ready,
      inReview,
      autoMerge: ctx.config.loop.autoMerge,
      ciRequired: ctx.entry.pr.required && ctx.entry.pr.ciRequired,
      prRequired: ctx.entry.pr.required,
      reviewCycleCap: ctx.config.loop.reviewCycleCap,
      viewerId,
    };
  },
  rules: [implementRule, reviewRule, mergeRule],
  escalations(snapshot) {
    return snapshot.inReview
      .filter((entry) => entry.requestChangesCycles >= snapshot.reviewCycleCap)
      .map(
        (entry): Escalation => ({
          issueId: entry.issue.identifier,
          kind: "review-cycle-exhausted",
          attempts: entry.requestChangesCycles,
          detail: `Latest review: ${entry.latestReview?.data.verdict ?? "none"} at ${entry.headSha || "unknown head"}.`,
        }),
      );
  },
};
