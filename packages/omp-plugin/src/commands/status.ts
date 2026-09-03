/**
 * `/foreman:status` — the in-chat operator console (SPEC §3.4, §17.4): the
 * blocked queue and the in-flight lock table. Two sections only, matching
 * the `foreman:` label vocabulary.
 */

import type { Issue, LinearWriter } from "@foreman/core";
import { BLOCKED_FILTER, RUNNING_FILTER, latestMarker, lockState, MARKER_KIND, readLockComment } from "@foreman/core";
import type { BlockedEntry, RunningEntry, StatusState } from "../render/index.ts";
import { renderStatusConsole } from "../render/index.ts";
import { liveDispatchIds } from "../runtime.ts";

function excerptFor(issue: Issue): string {
  const found = latestMarker<{ whatINeed: string }>(MARKER_KIND.block, issue.comments);
  return found?.data.whatINeed ?? "(no block marker found on this issue)";
}

export async function buildStatusState(linear: LinearWriter, now: Date = new Date()): Promise<StatusState> {
  const [blockedIssues, runningIssues] = await Promise.all([
    linear.issues({ filter: BLOCKED_FILTER, includeComments: true }),
    linear.issues({ filter: RUNNING_FILTER, includeComments: true }),
  ]);

  const blocked: BlockedEntry[] = blockedIssues.map((issue) => ({
    issueId: issue.identifier,
    excerpt: excerptFor(issue),
  }));

  const running: RunningEntry[] = runningIssues
    .map((issue) => {
      const found = readLockComment(issue.comments);
      if (!found) return null;
      const state = lockState(found.data, { now, liveDispatchIds: liveDispatchIds() });
      return {
        issueId: issue.identifier,
        agent: found.data.agent,
        dispatchId: found.data.dispatchId,
        ageMs: now.getTime() - new Date(found.data.takenAt).getTime(),
        pastTtl: state.expired,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return { blocked, running };
}

export async function renderStatus(linear: LinearWriter): Promise<string> {
  const state = await buildStatusState(linear, new Date());
  return renderStatusConsole(state);
}
