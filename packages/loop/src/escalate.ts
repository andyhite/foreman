/**
 * Escalation (SPEC §17.7): the loop stopped retrying, so the issue becomes the
 * operator's. Successor to the deleted `workers/decisions.ts` — the one place a
 * loop writes to Linear directly, because there is no agent output to validate,
 * only the loop's own exhausted counter.
 */
import { encodeMarker, FOREMAN_STATE, MARKER_KIND, resolveState } from "@foreman/core";
import type { BlockRecord, LinearWriter } from "@foreman/core";

export type EscalationKind = "retry-exhausted" | "review-cycle-exhausted";

export interface Escalation {
  issueId: string;
  kind: EscalationKind;
  attempts: number;
  detail: string;
}

/** Moves the issue to `Blocked` and posts a needs-decision block marker. Both escalation kinds come from the build loop's retry/review-cycle counters, so they land in the implementation-stage queue, not refine's `Needs Input`. Returns the log line. */
export async function applyEscalation(linear: LinearWriter, escalation: Escalation): Promise<string> {
  const issue = await linear.issue(escalation.issueId, { includeComments: false });
  if (!issue) return `${escalation.issueId}: escalation skipped, issue not found`;
  if (issue.state.name === FOREMAN_STATE.blocked) return `${escalation.issueId}: already ${FOREMAN_STATE.blocked}`;

  const whatINeed =
    escalation.kind === "retry-exhausted"
      ? `Dispatch failed ${escalation.attempts} time(s) and the retry cap is exhausted. ${escalation.detail}`
      : `Review→fix reached ${escalation.attempts} rounds without converging. ${escalation.detail}`;
  const block: BlockRecord = {
    blocked: true,
    type: "needs-decision",
    whatIWasDoing: `Running the loop for ${issue.identifier}.`,
    whatINeed,
    options: [
      { label: "fix by hand", tradeoff: "Fastest, but the loop learns nothing." },
      { label: "re-scope the issue", tradeoff: "Slower, but the loop can pick it up again." },
    ],
    recommendation: "re-scope the issue",
    stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "" },
    costOfWrongGuess: "Retrying a structurally broken issue burns model budget without progress.",
    blockedByIssues: [],
  };

  const states = await linear.workflowStates(issue.team.id);
  const target = resolveState("blocked", states);
  await linear.updateIssue(issue.id, { stateId: target.id, assigneeId: null });
  await linear.createComment({ issueId: issue.id, body: encodeMarker(MARKER_KIND.block, block, whatINeed) });
  return `${escalation.issueId}: escalated to ${FOREMAN_STATE.blocked} (${escalation.kind})`;
}
