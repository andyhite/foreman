/**
 * `/foreman:status` — the in-chat operator console (SPEC §3.4, §17.4): the
 * Needs Input and Blocked queues and the in-flight lock table.
 */

import { readFileSync } from "node:fs";
import type { Issue, LinearWriter } from "@foreman/core";
import {
  BACKLOG_FILTER,
  BLOCKED_FILTER,
  NEEDS_INPUT_FILTER,
  READY_FILTER,
  RUNNING_FILTER,
  latestMarker,
  lockState,
  MARKER_KIND,
  readLockComment,
} from "@foreman/core";
import type { BlockedEntry, LoopLiveness, RunningEntry, StatusState } from "../render/index.ts";
import { renderStatusConsole } from "../render/index.ts";
import { getConfig, getEntry, liveDispatchIds } from "../runtime.ts";

function excerptFor(issue: Issue): string {
  const found = latestMarker<{ whatINeed: string }>(MARKER_KIND.block, issue.comments, { authoredBy: null });
  return found?.data.whatINeed ?? "(no block marker found on this issue)";
}

/** Reads the loop's own process lock; a lock naming a dead pid is drift, not a running loop. */
function readLoopLiveness(stateDir: string, alias: string, name: "plan" | "build"): LoopLiveness | null {
  try {
    const raw = readFileSync(`${stateDir}/${alias}/${name}.lock`, "utf8");
    const info = JSON.parse(raw) as { pid: number; startedAt: string };
    try {
      process.kill(info.pid, 0);
    } catch {
      return null;
    }
    return { name, pid: info.pid, startedAt: info.startedAt };
  } catch {
    return null;
  }
}

export async function buildStatusState(linear: LinearWriter, now: Date = new Date()): Promise<StatusState> {
  const [needsInputIssues, blockedIssues, runningIssues, backlogIssues, readyIssues] = await Promise.all([
    linear.issues({ filter: NEEDS_INPUT_FILTER, includeComments: true }),
    linear.issues({ filter: BLOCKED_FILTER, includeComments: true }),
    linear.issues({ filter: RUNNING_FILTER, includeComments: true }),
    linear.issues({ filter: BACKLOG_FILTER, includeComments: false }),
    linear.issues({ filter: READY_FILTER, includeComments: false }),
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

  let loops: LoopLiveness[] = [];
  try {
    const stateDir = getConfig().loop.stateDir;
    const alias = getEntry().alias;
    loops = (["build", "plan"] as const)
      .map((name) => readLoopLiveness(stateDir, alias, name))
      .filter((entry): entry is LoopLiveness => entry !== null);
  } catch {
    // No registered repo for this cwd, or runtime not initialized — render
    // the console without loop liveness rather than fail the whole command.
  }

  return {
    needsInput,
    blocked,
    running,
    backlogCount: backlogIssues.length,
    readyCount: readyIssues.length,
    loops,
  };
}

export async function renderStatus(linear: LinearWriter): Promise<string> {
  const state = await buildStatusState(linear, new Date());
  return renderStatusConsole(state);
}
