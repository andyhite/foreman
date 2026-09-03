/**
 * `/foreman:unblock <ISSUE-ID> <reply>` — SPEC §9: records the operator's
 * reply as a `foreman:unblock` marker comment and clears the `blocked:*`
 * label. That is all — the loop's next pass re-dispatches implement, which
 * lands in resume mode.
 */

import type { LinearWriter, ResolvedRepoEntry } from "@foreman/core";
import { assertIssueInScope, encodeMarker, FOREMAN_LABEL, foremanLabel, MARKER_KIND } from "@foreman/core";

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

  const issue = await linear.issue(issueId);
  if (!issue) return { ok: false, message: `Unknown issue "${issueId}".` };
  if (entry) await assertIssueInScope({ linear, entry }, issue);


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

  return { ok: true, message: `${issueId} unblocked; the loop will re-dispatch on its next pass.` };
}
