/**
 * `/foreman:status` — the in-chat operator console (SPEC §3.4, §17.4):
 * blocked queue, in-flight locks, proposals awaiting approval, live agent
 * registry, loop state. Blocked queue first (SPEC §9).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistryEntry, BackpressureState, Issue, LinearWriter, LoopState, StatusState } from "@foreman/core";
import {
  BLOCKED_HUMAN_FILTER,
  IN_FLIGHT_FILTER,
  LABEL_GROUP,
  PROPOSALS_FILTER,
  decodeMarker,
  labelsInGroup,
  lockState,
  MARKER_KIND,
  readLockComment,
  renderStatusConsole,
} from "@foreman/core";
import { getConfig } from "../runtime.ts";

/** The loop's bookkeeping file this command reads read-only, tolerating absence. */
interface LoopBookkeeping {
  stage: string;
  workers: Array<{ worker: string; lastRunAt: string | null; dispatchCount: number }>;
  backpressure: { tripped: boolean; reason: string | null };
  agents: Array<{ agent: string; state: "running" | "idle" | "parked" | "aborted"; issueId: string | null }>;
}

function readLoopBookkeeping(stateDir: string): LoopBookkeeping | null {
  const path = join(stateDir, "loop-state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LoopBookkeeping;
  } catch {
    return null;
  }
}

function questionFor(issue: Issue): string {
  const found = decodeMarker<{ whatINeed: string }>(MARKER_KIND.block, issue.description ?? "");
  if (found) return found.whatINeed;
  const latestBlockComment = [...issue.comments]
    .reverse()
    .map((comment) => decodeMarker<{ whatINeed: string }>(MARKER_KIND.block, comment.body))
    .find((data) => data !== null);
  return latestBlockComment?.whatINeed ?? "(no BlockRecord found on this issue)";
}

export async function buildStatusState(linear: LinearWriter, stateDir: string, now: Date = new Date()): Promise<StatusState> {
  const [blockedIssues, inFlightIssues, proposalIssues] = await Promise.all([
    linear.issues({ filter: BLOCKED_HUMAN_FILTER, includeComments: true }),
    linear.issues({ filter: IN_FLIGHT_FILTER, includeComments: true }),
    linear.issues({ filter: PROPOSALS_FILTER }),
  ]);

  const blocked = blockedIssues.map((issue) => ({
    issueId: issue.identifier,
    type: labelsInGroup(issue, LABEL_GROUP.blocked)[0] ?? "unknown",
    question: questionFor(issue),
  }));

  const locks = inFlightIssues
    .map((issue) => {
      const found = readLockComment(issue.comments);
      if (!found) return null;
      const state = lockState(found.data, { now, liveDispatchIds: [] });
      return {
        issueId: issue.identifier,
        agent: found.data.agent,
        dispatchId: found.data.dispatchId,
        ageMs: now.getTime() - new Date(found.data.takenAt).getTime(),
        pastTtl: state.expired,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const bookkeeping = readLoopBookkeeping(stateDir);
  const loop: LoopState = bookkeeping
    ? { stage: bookkeeping.stage, workers: bookkeeping.workers }
    : { stage: "unknown (no loop bookkeeping found)", workers: [] };
  const backpressure: BackpressureState = bookkeeping?.backpressure ?? { tripped: false, reason: null };
  const agents: AgentRegistryEntry[] = bookkeeping?.agents ?? [];

  return {
    blocked,
    locks,
    proposalsAwaiting: { count: proposalIssues.length, issueIds: proposalIssues.map((issue) => issue.identifier) },
    agents,
    loop,
    backpressure,
  };
}

export async function renderStatus(linear: LinearWriter): Promise<string> {
  const config = getConfig();
  const state = await buildStatusState(linear, config.loop.stateDir);
  return renderStatusConsole(state);
}
