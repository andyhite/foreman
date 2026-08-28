/**
 * `/foreman:unblock <ISSUE-ID> <reply>` — SPEC §9: records the operator's
 * reply as a `foreman:unblock` marker comment and clears the `blocked:*`
 * label. That is all — the loop's next pass re-dispatches implement, which
 * lands in resume mode.
 */

import type { LinearWriter } from "@foreman/core";
import { encodeMarker, LABEL_GROUP, labelsInGroup, MARKER_KIND } from "@foreman/core";

export interface UnblockResult {
  ok: boolean;
  message: string;
}

export async function runUnblock(linear: LinearWriter, issueId: string, reply: string): Promise<UnblockResult> {
  if (reply.trim().length === 0) {
    return { ok: false, message: "A non-empty reply is required." };
  }

  const issue = await linear.issue(issueId);
  if (!issue) return { ok: false, message: `Unknown issue "${issueId}".` };

  const blockedLabelNames = labelsInGroup(issue, LABEL_GROUP.blocked);
  if (blockedLabelNames.length === 0) {
    return { ok: false, message: `${issueId} carries no blocked:* label; nothing to unblock.` };
  }

  const body = encodeMarker(MARKER_KIND.unblock, { reply }, `**Operator reply:** ${reply}`);
  await linear.createComment({ issueId: issue.id, body });

  const removedLabelIds = issue.labels.filter((label) => blockedLabelNames.includes(label.name)).map((label) => label.id);
  await linear.updateIssue(issue.id, { removedLabelIds });

  return { ok: true, message: `${issueId} unblocked; the loop will re-dispatch on its next pass.` };
}
