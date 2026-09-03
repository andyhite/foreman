/**
 * `/foreman:unblock <ISSUE-ID> <reply>` — SPEC §9: records the operator's
 * reply as a `foreman:unblock` marker comment and clears the `foreman:blocked`
 * label. That is normally all — the loop's next pass re-dispatches implement,
 * which lands in resume mode.
 *
 * One exception: when the latest `block` marker on the issue is a
 * `needs-decision` whose `recommendation` is `"cancel"` or `"duplicate"`
 * (triage's own park for those two dispositions — SPEC §7.1), and the
 * operator's trimmed, lower-cased reply is exactly that word, the issue is
 * also moved to the matching terminal state instead of being left in
 * Triage with no `foreman:` label, where it would otherwise be re-triaged
 * forever. Any other reply behaves exactly as before: label cleared, state
 * untouched.
 */

import type { LinearWriter, ResolvedRepoEntry } from "@foreman/core";
import {
  assertIssueInScope,
  encodeMarker,
  FOREMAN_LABEL,
  foremanLabel,
  latestMarker,
  MARKER_KIND,
  resolveState,
  type BlockRecord,
} from "@foreman/core";

export interface UnblockResult {
  ok: boolean;
  message: string;
}
export async function runUnblock(
  linear: LinearWriter,
  issueId: string,
  reply: string,
  entry?: ResolvedRepoEntry,
): Promise<UnblockResult> {
  if (reply.trim().length === 0) {
    return { ok: false, message: "A non-empty reply is required." };
  }

  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { ok: false, message: `Unknown issue "${issueId}".` };
  if (entry) await assertIssueInScope({ linear, entry }, issue);

  const recommendedTerminal = latestMarker<BlockRecord>(MARKER_KIND.block, issue.comments ?? [])?.data;
  const wantsTerminal =
    recommendedTerminal?.type === "needs-decision" &&
    (recommendedTerminal.recommendation === "cancel" || recommendedTerminal.recommendation === "duplicate") &&
    reply.trim().toLowerCase() === recommendedTerminal.recommendation;

  const held = foremanLabel(issue);
  if (held !== FOREMAN_LABEL.blocked) {
    return { ok: false, message: `${issueId} carries no \`${FOREMAN_LABEL.blocked}\` label; nothing to unblock.` };
  }

  const removedLabelIds = issue.labels.filter((label) => label.name === FOREMAN_LABEL.blocked).map((label) => label.id);
  // Clear the block only after the reply is recorded: a failed comment
  // leaves the safer blocked state instead of silently making work runnable
  // while the operator's answer is lost.
  const body = encodeMarker(MARKER_KIND.unblock, { reply }, `**Operator reply:** ${reply}`);
  await linear.createComment({ issueId: issue.id, body });
  await linear.updateIssue(issue.id, { removedLabelIds, assigneeId: null });

  if (wantsTerminal) {
    const states = await linear.workflowStates(issue.team.id);
    // `recommendedTerminal.recommendation` is triage's own literal ("cancel"
    // | "duplicate"); `resolveState` keys on `ForemanStateKey`, which spells
    // the canceled one "canceled". `resolveState` falls a bare "duplicate"
    // back to the canceled state when the team has no dedicated Duplicate
    // state (`domain/states.ts`).
    const stateKey = recommendedTerminal.recommendation === "cancel" ? "canceled" : "duplicate";
    const target = resolveState(stateKey, states);
    await linear.updateIssue(issue.id, { stateId: target.id });
    return { ok: true, message: `${issueId} unblocked and moved to ${target.name} (${recommendedTerminal.recommendation}).` };
  }

  return { ok: true, message: `${issueId} unblocked; the loop will re-dispatch on its next pass.` };
}
