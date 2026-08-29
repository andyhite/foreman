/**
 * The supervisor (SPEC §17.5, §17.4 "the loop is a singleton"): one process,
 * several independent workers with their own cadences, a shared lockfile,
 * shared global counters, one log. Four separate processes would multiply
 * the singleton problem by four and give no shared view of total load.
 *
 * SPEC §17 also asks for a control plane: pause/resume/tick-now/stop from a
 * TUI without killing the process, and a `status.json` snapshot an operator
 * can read without a live socket. Both ride on the same in-memory state this
 * class already keeps for `runTick`/`runForever` — a `ControlServer` is
 * wired in `main.ts`/`intake.ts`, not here, so this file stays testable
 * without a socket.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  IN_FLIGHT_FILTER,
  writeStatusFile,
  type AgentStatus,
  type ControlEvent,
  type EmittableEvent as CoreEmittableEvent,
  type Dispatcher,
  type DispatchHandle,
  type GlobalConfig,
  type LinearWriter,
  type LoopId,
  type LoopSnapshot,
  type LoopStage,
  type ResolvedRepoEntry,
  type RunState,
} from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import { buildSnapshot, type WorkerSnapshotInput } from "./snapshot.ts";
import type { BlockedItem, BoardCounts, ProposalItem, QueueItem } from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./workers/types.ts";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---- singleton lockfile (SPEC §17.4) -------------------------------------

export interface LoopLockInfo {
  pid: number;
  startedAt: string;
}

export class LoopLockHeldError extends Error {
  constructor(info: LoopLockInfo) {
    super(`foreman-loop already running (pid ${info.pid}, started ${info.startedAt}).`);
    this.name = "LoopLockHeldError";
  }
}

/** Seam over `process.kill(pid, 0)`, so tests can simulate a dead pid without spawning one. */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
}

export const nodeProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Two supervisors racing the same board is the one failure mode that
 * corrupts state rather than just wasting tokens (SPEC §17.4) — so a second
 * `acquire` against a live holder throws, and a holder whose pid is dead
 * (the process crashed without releasing) is taken over rather than left to
 * block the loop forever.
 */
export class SupervisorLock {
  readonly #path: string;
  #acquired = false;

  constructor(path: string) {
    this.#path = path;
  }

  acquire(pid: number, now: Date, probe: ProcessProbe = nodeProcessProbe): void {
    if (existsSync(this.#path)) {
      const info = JSON.parse(readFileSync(this.#path, "utf8")) as LoopLockInfo;
      if (probe.isAlive(info.pid)) {
        throw new LoopLockHeldError(info);
      }
      // Stale lock: the prior holder's pid is dead. Take it over.
    }
    mkdirSync(dirname(this.#path), { recursive: true });
    const info: LoopLockInfo = { pid, startedAt: now.toISOString() };
    writeFileSync(this.#path, JSON.stringify(info, null, 2), "utf8");
    this.#acquired = true;
  }

  release(): void {
    if (this.#acquired && existsSync(this.#path)) unlinkSync(this.#path);
    this.#acquired = false;
  }

  get acquired(): boolean {
    return this.#acquired;
  }
}

export function lockPathFor(stateDir: string): string {
  return join(stateDir, "loop.lock");
}

export function bookkeepingPathFor(stateDir: string): string {
  return join(stateDir, "bookkeeping.json");
}

// ---- dispatcher selection (SPEC §17.2) -----------------------------------

export interface DispatcherFactory {
  createPrint(): Dispatcher;
  createHerdr(): Dispatcher;
}

/**
 * Auto-detects herdr: tries it first and uses it when its server is
 * reachable, so agent workers land in real, attachable panes whenever herdr
 * is running. Falls back to print mode otherwise (SPEC §17.2: "Foreman
 * should degrade to print mode when the server isn't there rather than
 * stalling the loop"). Logs the fallback so it is visible, not silent.
 */
export async function resolveDispatcher(factory: DispatcherFactory, log: (message: string) => void): Promise<Dispatcher> {
  const herdr = factory.createHerdr();
  if (await herdr.available()) {
    return herdr;
  }
  log("herdr unavailable; falling back to PrintDispatcher.");
  return factory.createPrint();
}

// ---- supervisor -----------------------------------------------------------

export interface SupervisorOptions {
  config: GlobalConfig;
  linear: LinearWriter;
  dispatcher: Dispatcher;
  bookkeeping: Bookkeeping;
  stateDir: string;
  /** This instance's resolved registry entry (SPEC §3.11), threaded to every worker. */
  entry: ResolvedRepoEntry;
  now?: () => Date;
  log?: (message: string) => void;
  dryRun: boolean;
  /** Logs per-worker skip records in `runTick`, not just dispatch counts (SPEC §17.9). */
  verbose?: boolean;
  /** This loop's control-plane identity (contract §I/§J): who `status.json` and every broadcast event say they are. */
  loopId: LoopId;
  statusPath: string;
  version: string;
  team: string | null;
}

export interface RunTickOptions {
  /** Restrict this tick to named workers (SPEC §18 step 6: implement alone). */
  workerNames?: readonly string[];
}

/** Re-exported from core so the supervisor and the control server agree on what a producer may emit. */
type EmittableEvent = CoreEmittableEvent;

export class Supervisor {
  readonly #config0: { current: GlobalConfig };
  readonly #linear: LinearWriter;
  readonly #dispatcher: Dispatcher;
  readonly #bookkeeping: Bookkeeping;
  readonly #entry: ResolvedRepoEntry;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #verbose: boolean;
  readonly #lock: SupervisorLock;
  readonly #loopId: LoopId;
  readonly #statusPath: string;
  readonly #version: string;
  readonly #team: string | null;
  readonly #startedAt: string;
  /** True only when `--dry-run` was the operator's explicit flag, independent of `loop.stage` — `setStage`/`reloadConfig` must not erase it. */
  readonly #cliDryRun: boolean;

  #runState: RunState = "starting";
  #pausedAt: string | null = null;
  #ticks = 0;
  #lastTickAt: string | null = null;
  #wake: (() => void) | null = null;
  #tickRequest: readonly string[] | null | undefined = undefined;
  #stopMode: "graceful" | "now" | null = null;
  #stopped = false;

  readonly #workerMeta = new Map<string, { cadenceMs: number }>();
  readonly #runningWorkers = new Set<string>();
  readonly #lastRunAt = new Map<string, number>();
  readonly #reports = new Map<string, WorkerReport>();
  readonly #counts: Partial<BoardCounts> = {};
  /** Keyed by worker name so a later worker's re-fetch of the same list replaces only its own slice, not a sibling's (SPEC §17: "no extra Linear queries" means every worker's own last fetch is the only source of truth for its rows). */
  readonly #queuesBlocked = new Map<string, BlockedItem[]>();
  readonly #queuesProposals = new Map<string, ProposalItem[]>();
  readonly #queuesPipeline = new Map<string, QueueItem[]>();
  readonly #listeners = new Set<(event: ControlEvent) => void>();
  readonly #dispatchHistory: number[] = [];
  readonly #handles = new Map<string, DispatchHandle>();
  readonly #statuses = new Map<string, AgentStatus>();
  readonly #linearHealth = { ok: true, lastPollAt: null as string | null, lastError: null as string | null, requests: 0 };
  #seq = 0;

  constructor(options: SupervisorOptions) {
    this.#config0 = { current: options.config };
    this.#linear = options.linear;
    this.#dispatcher = options.dispatcher;
    this.#bookkeeping = options.bookkeeping;
    this.#entry = options.entry;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? ((message) => console.log(`[foreman-loop] ${message}`));
    this.#verbose = options.verbose ?? false;
    this.#lock = new SupervisorLock(lockPathFor(options.stateDir));
    this.#loopId = options.loopId;
    this.#statusPath = options.statusPath;
    this.#version = options.version;
    this.#team = options.team;
    this.#startedAt = this.#now().toISOString();
    this.#cliDryRun = options.dryRun && options.config.loop.stage !== "dry-run";
  }

  get bookkeeping(): Bookkeeping {
    return this.#bookkeeping;
  }

  get runState(): RunState {
    return this.#runState;
  }

  get dispatcher(): Dispatcher {
    return this.#dispatcher;
  }

  #config(): GlobalConfig {
    return this.#config0.current;
  }

  #dryRun(): boolean {
    return this.#cliDryRun || this.#config().loop.stage === "dry-run";
  }

  acquireLock(probe?: ProcessProbe): void {
    this.#lock.acquire(process.pid, this.#now(), probe);
    this.#runState = "running";
  }

  releaseLock(): void {
    this.#lock.release();
  }

  /** The `DispatchHandle` the wrapped dispatcher recorded for `dispatchId`, or null once cleared. */
  handleFor(dispatchId: string): DispatchHandle | null {
    return this.#handles.get(dispatchId) ?? null;
  }

  /** Drops everything this supervisor tracked about a dispatch — the counterpart to `Bookkeeping.clearDispatch`. */
  forgetHandle(dispatchId: string): void {
    this.#handles.delete(dispatchId);
    this.#statuses.delete(dispatchId);
  }

  /**
   * Reconciles bookkeeping against Linear on start (SPEC §11, §17.5): any
   * `inFlight` record for an issue that no longer carries `agent:running` is
   * dropped, since the extension released the lock (or it expired) while
   * this process was not running. Never touches Linear itself.
   */
  async reconcile(): Promise<void> {
    const before = this.#bookkeeping.state.inFlight.length;
    const running = await this.#linear.issues({ filter: IN_FLIGHT_FILTER, limit: 500 });
    const liveIssueIds = new Set(running.map((issue) => issue.identifier));
    const liveDispatchIds = new Set(this.#bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
    this.#bookkeeping.reconcile(liveIssueIds, liveDispatchIds);
    const dropped = before - this.#bookkeeping.state.inFlight.length;
    if (dropped > 0) {
      this.#log(`reconciled: dropped ${dropped} stale in-flight record(s)`);
    }
    this.#bookkeeping.save();
    this.publishStatus();
  }

  #emit(event: EmittableEvent): void {
    this.#seq += 1;
    const full = { ...event, seq: this.#seq, at: this.#now().toISOString() } as ControlEvent;
    for (const listener of this.#listeners) listener(full);
  }

  onEvent(handler: (event: ControlEvent) => void): () => void {
    this.#listeners.add(handler);
    return () => this.#listeners.delete(handler);
  }

  /** Atomic write of `status.json` (contract §M); IO failures are logged once and otherwise swallowed — a stale status file is a TUI staleness badge, not a crash. */
  publishStatus(): void {
    try {
      writeStatusFile(this.#statusPath, this.snapshot());
    } catch (error) {
      this.#log(`failed to publish status.json: ${String(error)}`);
    }
  }

  snapshot(): LoopSnapshot {
    const workers: WorkerSnapshotInput[] = [...this.#workerMeta.entries()].map(([name, meta]) => ({
      name,
      cadenceMs: meta.cadenceMs,
      lastRunAt: this.#lastRunAt.has(name) ? new Date(this.#lastRunAt.get(name) as number).toISOString() : null,
      running: this.#runningWorkers.has(name),
      lastReport: this.#reports.get(name) ?? null,
    }));
    const agentStatuses = new Map(
      [...this.#handles.keys()].map((dispatchId) => [
        dispatchId,
        { status: this.#statuses.get(dispatchId) ?? ("unknown" as AgentStatus), handle: this.#handles.get(dispatchId) ?? null },
      ]),
    );
    return buildSnapshot({
      loopId: this.#loopId,
      kind: "repo",
      label: this.#entry.alias,
      alias: this.#entry.alias,
      team: this.#team,
      repoPath: this.#entry.repoPath,
      initiativeIds: this.#entry.initiativeIds,
      pid: process.pid,
      startedAt: this.#startedAt,
      version: this.#version,
      config: this.#config(),
      runState: this.#runState,
      dryRun: this.#dryRun(),
      dispatcherKind: this.#dispatcher.kind,
      pausedAt: this.#pausedAt,
      lastTickAt: this.#lastTickAt,
      ticks: this.#ticks,
      now: this.#now(),
      workers,
      bookkeeping: this.#bookkeeping.state,
      agentStatuses,
      boardCounts: this.#counts,
      linear: this.#linearHealth,
      dispatchHistory: this.#dispatchHistory,
      queues: this.#flattenQueues(),
    });
  }

  /** Flattens every worker's last-known slice into one array per queue, last writer for a given issue id wins. */
  #flattenQueues(): { blocked: BlockedItem[]; proposals: ProposalItem[]; pipeline: QueueItem[] } {
    const byIssueId = <T extends { issueId: string }>(perWorker: Map<string, T[]>): T[] => {
      const merged = new Map<string, T>();
      for (const items of perWorker.values()) {
        for (const item of items) merged.set(item.issueId, item);
      }
      return [...merged.values()];
    };
    return {
      blocked: byIssueId(this.#queuesBlocked),
      proposals: byIssueId(this.#queuesProposals),
      pipeline: byIssueId(this.#queuesPipeline),
    };
  }

  pause(): void {
    this.#runState = "paused";
    this.#pausedAt = this.#now().toISOString();
    this.#emit({ event: "state", runtime: this.snapshot().runtime });
    this.publishStatus();
  }

  resume(): void {
    this.#runState = "running";
    this.#pausedAt = null;
    this.#emit({ event: "state", runtime: this.snapshot().runtime });
    this.publishStatus();
  }

  /** Wakes an in-progress `runForever` poll immediately, restricted to `workerNames` when given. */
  requestTick(workerNames?: readonly string[]): void {
    this.#tickRequest = workerNames ?? null;
    this.#wake?.();
  }

  /** `"now"` interrupts the poll wait immediately; `"graceful"` lets `runForever` finish its current tick, then exit on its next loop check. */
  requestStop(mode: "graceful" | "now"): void {
    this.#stopMode = mode;
    this.#runState = "draining";
    this.#emit({ event: "state", runtime: this.snapshot().runtime });
    if (mode === "now") this.#wake?.();
  }

  setStage(stage: LoopStage): void {
    this.#config0.current = { ...this.#config(), loop: { ...this.#config().loop, stage } };
    this.publishStatus();
  }

  reloadConfig(config: GlobalConfig): void {
    this.#config0.current = config;
    this.publishStatus();
  }

  #context(): WorkerContext {
    return {
      config: this.#config(),
      bookkeeping: this.#bookkeeping,
      dispatcher: this.#wrappedDispatcher(),
      linear: this.#linear,
      entry: this.#entry,
      now: this.#now,
      log: (message: string) => {
        this.#log(message);
        this.#emit({ event: "log", level: "info", line: message });
      },
      dryRun: this.#dryRun(),
    };
  }

  /**
   * Wraps the real dispatcher so every dispatch this process makes lands in
   * `#handles`/`#statuses` — the only way the supervisor can later report a
   * `DispatchHandle`'s `pid`/`herdr` pane, since workers call `dispatch()`
   * directly and never hand the handle back beyond what `Bookkeeping`
   * already stores (agent/issueId/dispatchId/startedAt/stage, no pane info).
   */
  #wrappedDispatcher(): Dispatcher {
    const inner = this.#dispatcher;
    return {
      kind: inner.kind,
      dispatch: async (request) => {
        const handle = await inner.dispatch(request);
        this.#handles.set(handle.dispatchId, handle);
        this.#statuses.set(handle.dispatchId, "starting");
        return handle;
      },
      status: (handle) => inner.status(handle),
      settle: (handle) => inner.settle(handle),
      attach: inner.attach ? async (handle) => void (await inner.attach?.(handle)) : undefined,
      available: () => inner.available(),
    };
  }

  /** Runs each selected worker exactly once, saving bookkeeping after each. */
  async runTick(workers: readonly Worker[], options: RunTickOptions = {}): Promise<WorkerReport[]> {
    const selected = options.workerNames
      ? workers.filter((worker) => options.workerNames?.includes(worker.name))
      : workers;
    const reports: WorkerReport[] = [];
    for (const worker of selected) {
      this.#workerMeta.set(worker.name, { cadenceMs: worker.cadenceMs });
      const beforeIds = new Set(this.#bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
      this.#runningWorkers.add(worker.name);
      let report: WorkerReport;
      try {
        report = await worker.run(this.#context());
        this.#log(
          `${worker.name}: ${report.dispatched.length} dispatched, ${report.skipped.length} skipped` +
            (report.errors.length > 0 ? `, ${report.errors.length} error(s)` : ""),
        );
        for (const decision of report.dispatched) {
          this.#log(`  → ${worker.name} ${decision.issueId ?? "(batch)"}: ${decision.reason}`);
        }
        if (this.#verbose) {
          for (const skip of report.skipped) {
            this.#log(`  skip ${worker.name} ${skip.issueId ?? "(batch)"}: ${skip.code} — ${skip.message}`);
          }
        }
      } catch (error) {
        this.#log(`${worker.name} failed: ${String(error)}`);
        report = {
          worker: worker.name as WorkerReport["worker"],
          ranAt: this.#now().toISOString(),
          dispatched: [],
          skipped: [],
          errors: [String(error)],
        };
      }
      this.#runningWorkers.delete(worker.name);
      this.#lastRunAt.set(worker.name, this.#now().getTime());
      this.#reports.set(worker.name, report);
      if (report.counts) Object.assign(this.#counts, report.counts);
      if (report.queues?.blocked) this.#queuesBlocked.set(worker.name, report.queues.blocked);
      if (report.queues?.proposals) this.#queuesProposals.set(worker.name, report.queues.proposals);
      if (report.queues?.pipeline) this.#queuesPipeline.set(worker.name, report.queues.pipeline);
      this.#emit({
        event: "tick",
        worker: worker.name,
        dispatched: report.dispatched.length,
        skipped: report.skipped.length,
        errors: report.errors.length,
      });
      reports.push(report);
      this.#bookkeeping.save();

      const afterIds = new Set(this.#bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
      const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
      if (newIds.length > 0) {
        const agents = this.snapshot().agents;
        for (const id of newIds) {
          const agent = agents.find((candidate) => candidate.dispatchId === id);
          if (agent) this.#emit({ event: "dispatch", agent });
        }
      }
    }

    this.#ticks += 1;
    this.#lastTickAt = this.#now().toISOString();
    const totalDispatched = reports.reduce((sum, report) => sum + report.dispatched.length, 0);
    this.#dispatchHistory.push(totalDispatched);
    if (this.#dispatchHistory.length > 60) this.#dispatchHistory.splice(0, this.#dispatchHistory.length - 60);

    await this.#refreshAgentStatuses();
    this.publishStatus();
    return reports;
  }

  /** Best-effort per-tick status refresh for every in-flight dispatch this process still holds a handle for. */
  async #refreshAgentStatuses(): Promise<void> {
    for (const entry of this.#bookkeeping.state.inFlight) {
      const handle = this.#handles.get(entry.dispatchId);
      if (!handle) continue;
      try {
        this.#statuses.set(entry.dispatchId, await this.#dispatcher.status(handle));
      } catch {
        this.#statuses.set(entry.dispatchId, "lost");
      }
    }
  }

  /**
   * Runs forever on each worker's own cadence until `stop()`/`requestStop()`
   * takes effect. The wait between cadence checks is interruptible
   * (`requestTick`/`requestStop("now")` resolve it immediately via `#wake`)
   * rather than always sleeping the full `pollMs`, so a TUI's "tick now"
   * doesn't wait up to 30s to take effect.
   */
  async runForever(
    workers: readonly Worker[],
    options: { workerNames?: readonly string[]; pollMs?: number } = {},
  ): Promise<void> {
    const pollMs = options.pollMs ?? 30_000;
    if (this.#runState === "starting") this.#runState = "running";
    while (!this.#stopped) {
      const state = this.#currentRunState();
      if (state === "draining") break;
      if (state === "paused") {
        await this.#interruptibleWait(pollMs);
        continue;
      }

      const requested = this.#tickRequest;
      this.#tickRequest = undefined;
      const nowMs = this.#now().getTime();
      const due = workers.filter((worker) => {
        if (options.workerNames && !options.workerNames.includes(worker.name)) return false;
        if (requested !== undefined) return requested === null || requested.includes(worker.name);
        const last = this.#lastRunAt.get(worker.name) ?? 0;
        return nowMs - last >= worker.cadenceMs;
      });
      if (due.length > 0) {
        await this.runTick(due, { workerNames: due.map((worker) => worker.name) });
      }
      if (this.#currentRunState() === "draining") break;
      await this.#interruptibleWait(pollMs);
    }
    this.#runState = "stopped";
    this.releaseLock();
    this.#emit({ event: "state", runtime: this.snapshot().runtime });
    this.publishStatus();
  }

  /** `sleep(ms)`, but a pending `#wake` call (from `requestTick`/`requestStop("now")`) resolves it early. */
  async #interruptibleWait(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#wake = resolve;
    await Promise.race([promise, sleep(ms)]);
    this.#wake = null;
  }

  /**
   * The run state, read through a call rather than the field.
   *
   * `#runState = "running"` above narrows the field to that literal for the
   * rest of the block, and TypeScript keeps the narrowing across every
   * `await` in the loop body — so a later `=== "draining"` is reported as a
   * comparison between non-overlapping literals even though `requestStop`
   * writes exactly that value from another turn. A call boundary returns the
   * declared type and stays honest. `IntakeRuntime` does the same.
   */
  #currentRunState(): RunState {
    return this.#runState;
  }

  stop(): void {
    this.#stopped = true;
    this.#runState = "stopped";
    this.releaseLock();
  }
}
