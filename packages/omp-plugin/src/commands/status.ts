/**
 * `/foreman:status` — the in-chat operator console (SPEC §3.4, §17.4):
 * blocked queue, in-flight locks, proposals awaiting approval, live agent
 * registry, loop state. Blocked queue first (SPEC §9).
 */

import { join } from "node:path";
import type { AgentRegistryEntry, AgentStatus, BackpressureState, Issue, LinearWriter, LoopState, StatusState, WorkerLoopState } from "@foreman/core";
import {
  BLOCKED_HUMAN_FILTER,
  IN_FLIGHT_FILTER,
  LABEL_GROUP,
  PROPOSALS_FILTER,
  decodeMarker,
  expandHome,
  labelsInGroup,
  lockState,
  MARKER_KIND,
  readLockComment,
  readStatusFile,
  renderStatusConsole,
} from "@foreman/core";
import { getConfig, getEntry } from "../runtime.ts";

/** `AgentStatus` (contract §J) has no `"idle"`/`"parked"`/`"aborted"` distinction; this is the closest honest mapping onto the older registry vocabulary `/foreman:status` already renders. */
const AGENT_REGISTRY_STATE: Record<AgentStatus, AgentRegistryEntry["state"]> = {
  starting: "idle",
  running: "running",
  settled: "parked",
  lost: "aborted",
  unknown: "idle",
};

function readLoopState(stateDir: string): { loop: LoopState; backpressure: BackpressureState; agents: AgentRegistryEntry[] } {
  const status = readStatusFile(join(stateDir, "status.json"));
  if (!status) {
    return { loop: { stage: "unknown (no running loop)", workers: [] }, backpressure: { tripped: false, reason: null }, agents: [] };
  }
  const { snapshot } = status;
  const workers: WorkerLoopState[] = snapshot.workers.map((worker) => ({
    worker: worker.name,
    lastRunAt: worker.lastRunAt,
    dispatchCount: worker.dispatched,
  }));
  const agents: AgentRegistryEntry[] = snapshot.agents.map((agent) => ({
    agent: agent.agent,
    state: AGENT_REGISTRY_STATE[agent.status],
    issueId: agent.issueId,
  }));
  return {
    loop: { stage: snapshot.runtime.stage, workers },
    backpressure: { tripped: snapshot.backpressure.tripped, reason: snapshot.backpressure.reason },
    agents,
  };
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

  const { loop, backpressure, agents } = readLoopState(stateDir);

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
  const stateDir = join(expandHome(config.loop.stateDir), getEntry().alias);
  const state = await buildStatusState(linear, stateDir);
  return renderStatusConsole(state);
}
