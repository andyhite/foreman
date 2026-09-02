/**
 * Assembles a `LoopSnapshot` (contract §J, `@foreman/core/control/protocol`)
 * from whatever the supervisor already has in memory: config, the resolved
 * registry entry, bookkeeping, and the last report from each worker.
 *
 * Pure and synchronous on purpose — `Supervisor.snapshot()` calls this on
 * every tick and every control request, and a TUI attaching mid-tick must
 * see a consistent view without waiting on a fresh Linear round trip. No
 * function in this file makes a network call or reads a file; every field
 * comes from an argument. That is also why it is unit-testable without a
 * live loop (`test/snapshot.test.ts`).
 */

import {
  decodeMarker,
  emptyBoardCounts,
  labelsInGroup,
  latestMarker,
  LABEL_GROUP,
  lockTtlMs,
  MARKER_KIND,
  resolveRepoEntry,
  stripControlChars,
  worktreePathFor,
  type AgentStatus,
  type AgentView,
  type BlockedItem,
  type BlockRecord,
  type BoardCounts,
  type DispatchHandle,
  type GlobalConfig,
  type Issue,
  type LoopId,
  type LoopKind,
  type LoopMode,
  type LoopSnapshot,
  type ProposalItem,
  type QueueItem,
  type RunState,
} from "@foreman/core";
import type { BookkeepingState } from "./bookkeeping.ts";
import type { WorkerReport } from "./workers/types.ts";

/** Maps a Linear issue already in hand to the TUI's flat pipeline row — no re-fetch. */
export function toQueueItem(issue: Issue): QueueItem {
  return {
    issueId: issue.identifier,
    title: stripControlChars(issue.title),
    state: issue.state.name,
    priority: issue.priority,
    estimate: issue.estimate,
    labels: issue.labels.map((label) => label.name),
    assignee: issue.assignee?.displayName ?? null,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

/** Maps a blocked-human issue to `BlockedItem`, reusing the same marker decode as `/foreman:status`. */
export function toBlockedItem(issue: Issue): BlockedItem {
  const found =
    decodeMarker<BlockRecord>(MARKER_KIND.block, issue.description ?? "") ??
    [...issue.comments]
      .reverse()
      .map((comment) => decodeMarker<BlockRecord>(MARKER_KIND.block, comment.body))
      .find((data) => data !== null) ??
    null;
  return {
    issueId: issue.identifier,
    title: stripControlChars(issue.title),
    type: labelsInGroup(issue, LABEL_GROUP.blocked)[0] ?? "unknown",
    question: stripControlChars(found?.whatINeed ?? "(no BlockRecord found on this issue)"),
    detectedAt: null,
    options: found?.options ?? [],
    recommendation: found?.recommendation ?? null,
  };
}

/** Maps a Triage proposal issue to `ProposalItem` from its `proposal` marker. */
export function toProposalItem(issue: Issue): ProposalItem {
  const marker = latestMarker<{
    destination: string;
    proposedPriority: number | null;
    duplicateOf: string | null;
  }>(MARKER_KIND.proposal, issue.comments);
  return {
    issueId: issue.identifier,
    title: stripControlChars(issue.title),
    destination: marker?.data.destination ?? "unknown",
    proposedPriority: marker?.data.proposedPriority ?? null,
    duplicateOf: marker?.data.duplicateOf ?? null,
    proposedAt: marker?.createdAt ?? issue.updatedAt,
  };
}

export interface WorkerSnapshotInput {
  name: string;
  cadenceMs: number;
  lastRunAt: string | null;
  running: boolean;
  lastReport: WorkerReport | null;
}

export interface AgentSnapshotInput {
  status: AgentStatus;
  handle: DispatchHandle | null;
}

export interface BuildSnapshotInput {
  loopId: LoopId;
  kind: LoopKind;
  label: string;
  alias: string | null;
  team: string | null;
  repoPath: string | null;
  initiativeIds: readonly string[];
  pid: number;
  startedAt: string;
  version: string;
  config: GlobalConfig;
  runState: RunState;
  dispatcherKind: "herdr" | "print" | "none";
  pausedAt: string | null;
  lastTickAt: string | null;
  ticks: number;
  now: Date;
  workers: readonly WorkerSnapshotInput[];
  bookkeeping: BookkeepingState;
  /** Keyed by `DispatchRecordEntry.dispatchId`; entries absent here default to `"unknown"`. */
  agentStatuses: ReadonlyMap<string, AgentSnapshotInput>;
  /** Board counts merged from every worker's `WorkerReport.counts` this run. */
  boardCounts: Partial<BoardCounts>;
  linear: { ok: boolean; lastPollAt: string | null; lastError: string | null; requests: number };
  dispatchHistory: readonly number[];
  queues?: { blocked?: BlockedItem[]; proposals?: ProposalItem[]; pipeline?: QueueItem[] };
}

function nextRunAt(lastRunAt: string | null, cadenceMs: number): string | null {
  if (!lastRunAt) return null;
  return new Date(new Date(lastRunAt).getTime() + cadenceMs).toISOString();
}

/** Builds the frozen `LoopSnapshot` shape (contract §J) from in-memory state only. */
export function buildSnapshot(input: BuildSnapshotInput): LoopSnapshot {
  const nowMs = input.now.getTime();
  const board: BoardCounts = { ...emptyBoardCounts(), ...input.boardCounts };

  const workers = input.workers.map((worker) => {
    const report = worker.lastReport;
    return {
      name: worker.name,
      cadenceMs: worker.cadenceMs,
      lastRunAt: worker.lastRunAt,
      nextRunAt: nextRunAt(worker.lastRunAt, worker.cadenceMs),
      running: worker.running,
      dispatched: report?.dispatched.length ?? 0,
      skipped: report?.skipped.length ?? 0,
      errors: report?.errors.length ?? 0,
      lastSkips: (report?.skipped ?? []).slice(-8).map((skip) => ({
        issueId: skip.issueId,
        code: skip.code,
        message: skip.message,
      })),
      lastError: report?.errors.at(-1) ?? null,
    };
  });

  const candidateNextTicks = workers
    .map((worker) => worker.nextRunAt)
    .filter((value): value is string => value !== null)
    .sort();
  const nextTickAt = candidateNextTicks[0] ?? null;

  const ttlMs = lockTtlMs(input.config);
  const worktreePattern = input.alias && input.config.repos[input.alias]
    ? resolveRepoEntry(input.config, input.alias).worktreePattern
    : input.config.repoDefaults.worktreePattern;
  const agents: AgentView[] = input.bookkeeping.inFlight.map((entry) => {
    const started = new Date(entry.startedAt).getTime();
    const ageMs = nowMs - started;
    const snapshot = input.agentStatuses.get(entry.dispatchId) ?? null;
    const worktree =
      entry.issueId && input.repoPath
        ? worktreePathFor(worktreePattern, input.repoPath, { identifier: entry.issueId })
        : null;
    return {
      dispatchId: entry.dispatchId,
      agent: entry.agent,
      stage: entry.stage,
      issueId: entry.issueId,
      projectId: entry.projectId ?? null,
      startedAt: entry.startedAt,
      ageMs,
      status: snapshot?.status ?? "unknown",
      herdr: snapshot?.handle?.herdr ?? null,
      pid: snapshot?.handle?.pid ?? null,
      worktree,
      ttlMs,
      pastTtl: ageMs > ttlMs,
    };
  });

  const blockedCount = board.blocked;
  const threshold = input.config.loop.backpressureThreshold;
  const tripped = blockedCount > threshold;

  return {
    loop: {
      id: input.loopId,
      kind: input.kind,
      label: input.label,
      alias: input.alias,
      team: input.team,
      repoPath: input.repoPath,
      initiativeIds: [...input.initiativeIds],
      pid: input.pid,
      startedAt: input.startedAt,
      version: input.version,
    },
    runtime: {
      state: input.runState,
      mode: input.config.loop.mode,
      dispatcher: input.dispatcherKind,
      pausedAt: input.pausedAt,
      lastTickAt: input.lastTickAt,
      nextTickAt,
      ticks: input.ticks,
      uptimeMs: Math.max(0, nowMs - new Date(input.startedAt).getTime()),
    },
    workers,
    agents,
    wip: {
      global: { used: input.bookkeeping.inFlight.length, cap: input.config.loop.wipGlobal },
      byStage: (["refine", "implement", "review", "plan"] as const).map((stage) => ({
        stage,
        used: input.bookkeeping.inFlight.filter((entry) => entry.stage === stage).length,
        cap: input.config.loop.wip[stage],
      })),
    },
    backpressure: {
      tripped,
      blockedCount,
      threshold,
      reason: tripped ? "Blocked-human queue exceeds the backpressure threshold." : null,
    },
    board,
    queues: {
      blocked: input.queues?.blocked ?? [],
      proposals: input.queues?.proposals ?? [],
      decisions: input.bookkeeping.pendingDecisions.map((decision) => ({
        issueId: decision.issueId,
        stage: decision.stage,
        kind: decision.kind,
        attempts: decision.attempts,
        detectedAt: decision.detectedAt,
      })),
      pipeline: input.queues?.pipeline ?? [],
    },
    linear: input.linear,
    history: { dispatchesPerTick: [...input.dispatchHistory] },
  };
}
