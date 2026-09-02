/**
 * Applies a `PendingDecision` (SPEC §17.8) through Linear: adds
 * `blocked:needs-decision`, removes `agent:running` if present, and posts a
 * comment explaining why the loop stopped retrying. This is the one place a
 * worker writes to Linear directly, rather than through the extension's
 * structured-output consumer — the loop has no agent output to validate
 * here, only its own exhausted counter.
 */

import { AGENT_LABEL, BLOCKED_LABEL, hasLabel } from "@foreman/core";
import type { PendingDecision } from "../bookkeeping.ts";
import type { WorkerContext } from "./types.ts";

function describePendingDecision(decision: PendingDecision): string {
  if (decision.kind === "retry-exhausted") {
    return (
      `\`${decision.stage}\` failed ${decision.attempts} time(s) for ${decision.issueId} — ` +
      `retry cap exceeded. Converting to a decision rather than retrying an issue that is ` +
      `structurally broken.`
    );
  }
  return (
    `Review→fix cycle on ${decision.issueId} reached ${decision.attempts} rounds — ` +
    `review-cycle cap exceeded. Findings and the last implement result are attached above.`
  );
}

/**
 * Writes each decision to Linear and returns a list of human-readable
 * strings for the worker's error/log channel (SPEC §17.8's "attached").
 */
export async function applyPendingDecisions(
  ctx: WorkerContext,
  decisions: readonly PendingDecision[],
): Promise<string[]> {
  const notes: string[] = [];
  for (const decision of decisions) {
    const issue = await ctx.linear.issue(decision.issueId);
    if (!issue) {
      notes.push(`pending decision for ${decision.issueId} skipped: issue not found`);
      continue;
    }
    const summary = `mark ${decision.issueId} blocked:needs-decision (${decision.kind})`;
    if (!(await ctx.confirm({ kind: "linear-write", summary }))) {
      notes.push(`${decision.issueId}: declined (${decision.kind}); left as-is.`);
      continue;
    }
    const removedLabelIds = hasLabel(issue, AGENT_LABEL.running)
      ? issue.labels.filter((label) => label.name === AGENT_LABEL.running).map((label) => label.id)
      : [];
    const needsDecisionLabel = await ctx.linear.ensureLabel(BLOCKED_LABEL.needsDecision, issue.team.id);
    await ctx.linear.updateIssue(issue.id, {
      addedLabelIds: [needsDecisionLabel.id],
      removedLabelIds,
    });
    await ctx.linear.createComment({ issueId: issue.id, body: describePendingDecision(decision) });
    notes.push(`${decision.issueId}: converted to blocked:needs-decision (${decision.kind}).`);
  }
  return notes;
}
