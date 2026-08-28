/**
 * `/foreman-status` operator console (SPEC §3.4, §17.4). Not a Linear
 * artifact — this renders in-chat, so it stays terminal-readable rather than
 * matching the Markdown conventions of the other renderers.
 */

export interface BlockedEntry {
  issueId: string;
  type: string;
  question: string;
}

export interface LockEntry {
  issueId: string;
  agent: string;
  dispatchId: string;
  ageMs: number;
  pastTtl: boolean;
}

export interface ProposalsAwaiting {
  count: number;
  issueIds: string[];
}

export interface AgentRegistryEntry {
  agent: string;
  state: "running" | "idle" | "parked" | "aborted";
  issueId: string | null;
}

export interface WorkerLoopState {
  worker: string;
  lastRunAt: string | null;
  dispatchCount: number;
}

export interface LoopState {
  stage: string;
  workers: WorkerLoopState[];
}

export interface BackpressureState {
  tripped: boolean;
  reason: string | null;
}

export interface StatusState {
  blocked: BlockedEntry[];
  locks: LockEntry[];
  proposalsAwaiting: ProposalsAwaiting;
  agents: AgentRegistryEntry[];
  loop: LoopState;
  backpressure: BackpressureState;
}

function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/**
 * SPEC §3.4: blocked queue, in-flight locks, proposals awaiting approval,
 * live agent registry, loop state. Blocked queue is first — SPEC §9 makes it
 * where the operator's attention goes, drained once or twice daily.
 */
export function renderStatusConsole(state: StatusState): string {
  const sections: string[] = [];

  sections.push("## Blocked (human)");
  sections.push(
    state.blocked.length > 0
      ? state.blocked
          .map((entry) => `- ${entry.issueId} [${entry.type}] ${entry.question}`)
          .join("\n")
      : "_none — nothing waiting on the operator_",
  );

  sections.push("## Locks");
  sections.push(
    state.locks.length > 0
      ? state.locks
          .map(
            (lock) =>
              `- ${lock.issueId} held by ${lock.agent} (dispatch ${lock.dispatchId}, ` +
              `age ${formatAge(lock.ageMs)}${lock.pastTtl ? ", PAST TTL" : ""})`,
          )
          .join("\n")
      : "_none_",
  );

  sections.push("## Proposals awaiting approval");
  sections.push(
    state.proposalsAwaiting.count > 0
      ? `${state.proposalsAwaiting.count} pending: ${state.proposalsAwaiting.issueIds.join(", ")}`
      : "_none_",
  );

  sections.push("## Agent registry");
  sections.push(
    state.agents.length > 0
      ? state.agents
          .map((entry) => `- ${entry.agent}: ${entry.state}${entry.issueId ? ` (${entry.issueId})` : ""}`)
          .join("\n")
      : "_none_",
  );

  sections.push("## Loop");
  const workerLines =
    state.loop.workers.length > 0
      ? state.loop.workers
          .map(
            (worker) =>
              `- ${worker.worker}: last run ${worker.lastRunAt ?? "never"}, ` +
              `${worker.dispatchCount} dispatched`,
          )
          .join("\n")
      : "_none_";
  sections.push(`Stage: ${state.loop.stage}\n${workerLines}`);

  sections.push("## Backpressure");
  sections.push(
    state.backpressure.tripped
      ? `TRIPPED — ${state.backpressure.reason ?? "no reason recorded"}`
      : "clear",
  );

  return sections.join("\n\n");
}
