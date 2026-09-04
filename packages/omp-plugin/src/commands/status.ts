/**
 * `/foreman:status` — the in-chat operator console (SPEC §3.4, §17.4): the
 * Needs Input and Blocked queues and the in-flight lock table.
 */

import type { Issue, LinearWriter } from "@foreman/core";
import { BLOCKED_FILTER, NEEDS_INPUT_FILTER, RUNNING_FILTER, latestMarker, lockState, MARKER_KIND, readLockComment } from "@foreman/core";
import type { BlockedEntry, RunningEntry, StatusState } from "../render/index.ts";
import { renderStatusConsole } from "../render/index.ts";
import { liveDispatchIds } from "../runtime.ts";

function excerptFor(issue: Issue): string {
  const found = latestMarker<{ whatINeed: string }>(MARKER_KIND.block, issue.comments, { authoredBy: null });
  return found?.data.whatINeed ?? "(no block marker found on this issue)";
}

export async function buildStatusState(linear: LinearWriter, now: Date = new Date()): Promise<StatusState> {
  const [needsInputIssues, blockedIssues, runningIssues] = await Promise.all([
    linear.issues({ filter: NEEDS_INPUT_FILTER, includeComments: true }),
    linear.issues({ filter: BLOCKED_FILTER, includeComments: true }),
    linear.issues({ filter: RUNNING_FILTER, includeComments: true }),
  ]);

  const toEntry = (issue: Issue): BlockedEntry => ({ issueId: issue.identifier, excerpt: excerptFor(issue) });
  const needsInput: BlockedEntry[] = needsInputIssues.map(toEntry);
  const blocked: BlockedEntry[] = blockedIssues.map(toEntry);

  const running: RunningEntry[] = runningIssues.map((issue) => {
    const found = readLockComment(issue.comments, null);
    // A state in `RUNNING_FILTER` with no matching lock comment is drift
    // `reconcile`'s stale-running invariant repairs — surfaced here rather
    // than dropped, so the headline count and this section agree
    // (SPEC §17.6, §17.7).
    if (!found) {
      return { issueId: issue.identifier, agent: "(unknown)", dispatchId: "(no lock comment)", ageMs: 0, pastTtl: true };
    }
    const state = lockState(found.data, { now, liveDispatchIds: liveDispatchIds() });
    return {
      issueId: issue.identifier,
      agent: found.data.agent,
      dispatchId: found.data.dispatchId,
      ageMs: now.getTime() - new Date(found.data.takenAt).getTime(),
      pastTtl: state.expired,
    };
  });

  return { needsInput, blocked, running };
}

export async function renderStatus(linear: LinearWriter): Promise<string> {
  const state = await buildStatusState(linear, new Date());
  return renderStatusConsole(state);
}
