/**
 * `/foreman:unblock <ISSUE-ID> <reply>` — SPEC §9: records the operator's
 * reply as a `foreman:unblock` marker comment and moves the issue out of its
 * human-interrupt state, back into the queue that stage resumes from:
 * `Needs Input` (foreman-refine stalled) returns to `Backlog`, so the next
 * refine dispatch picks it back up with the operator's answer in hand;
 * `Blocked` (foreman-implement/foreman-review stalled) returns to `Ready`,
 * so the next implement dispatch resumes from the worktree it left behind.
 *
 * One exception: when the latest `block` marker on the issue is a
 * `needs-decision` whose `recommendation` is `"cancel"` or `"duplicate"`
 * (triage's own park for those two dispositions — SPEC §7.1), and the
 * operator's trimmed, lower-cased reply is exactly that word, the issue is
 * also moved to the matching terminal state instead. Any other reply behaves
 * exactly as above.
 */

import type { ForemanStateKey, LinearWriter, ResolvedRepoEntry } from "@foreman/core";
import {
  assertIssueInScope,
  encodeMarker,
  FOREMAN_STATE,
  latestMarker,
  MARKER_KIND,
  resolveState,
  type BlockRecord,
} from "@foreman/core";

/** Where `/foreman:unblock` resumes each human-interrupt state, keyed by the state's own Linear name. */
const RESUME_STATE: Record<string, ForemanStateKey> = {
  [FOREMAN_STATE.needsInput]: "backlog",
  [FOREMAN_STATE.blocked]: "ready",
};

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
  if (entry) assertIssueInScope(entry, issue);

  const resumeKey = RESUME_STATE[issue.state.name];
  if (!resumeKey) {
    return {
      ok: false,
      message: `${issueId} is ${issue.state.name}, not ${FOREMAN_STATE.needsInput} or ${FOREMAN_STATE.blocked}; nothing to unblock.`,
    };
  }

  // A forged `recommendation: "cancel"`/`"duplicate"` marker from another
  // Linear user must not turn the operator's reply into a terminal
  // disposition, so the marker is trusted only when authored by this
  // credential's own viewer id (mirrors `merge.ts`'s `latestReview`).
  let viewerId: string | null;
  try {
    viewerId = await linear.viewerId();
  } catch {
    viewerId = null;
  }
  const recommendedTerminal =
    viewerId !== null
      ? latestMarker<BlockRecord>(MARKER_KIND.block, issue.comments ?? [], { authoredBy: viewerId })?.data
      : undefined;
  const wantsTerminal =
    recommendedTerminal?.type === "needs-decision" &&
    (recommendedTerminal.recommendation === "cancel" || recommendedTerminal.recommendation === "duplicate") &&
    reply.trim().toLowerCase() === recommendedTerminal.recommendation;

  // Post the reply before moving state: a failed comment leaves the issue
  // blocked instead of silently making work runnable while the operator's
  // answer is lost.
  const body = encodeMarker(MARKER_KIND.unblock, { reply }, `**Operator reply:** ${reply}`);
  await linear.createComment({ issueId: issue.id, body });

  const states = await linear.workflowStates(issue.team.id);
  // `recommendedTerminal.recommendation` is triage's own literal ("cancel" |
  // "duplicate"); `resolveState` keys on `ForemanStateKey`, which spells the
  // canceled one "canceled". Both are provisioned states, so `resolveState`
  // throws rather than falling back when either is missing from the team.
  const target = wantsTerminal
    ? resolveState(recommendedTerminal.recommendation === "cancel" ? "canceled" : "duplicate", states)
    : resolveState(resumeKey, states);
  await linear.updateIssue(issue.id, { stateId: target.id, assigneeId: null });

  return { ok: true, message: `${issueId} unblocked and moved to ${target.name}.` };
}
