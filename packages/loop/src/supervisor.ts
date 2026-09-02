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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isHerdrUnavailable } from "./dispatch/index.ts";
import {
  BATCH_SUBJECT,
  IN_FLIGHT_FILTER,
  LinearApiError,
  lockTtlMs,
  reservationsPath,
  reserveDispatches,
  style,
  writeStatusFile,
  type AgentStatus,
  type ControlEvent,
  type EmittableEvent as CoreEmittableEvent,
  type Confirmer,
  type Dispatcher,
  type DispatchHandle,
  type DispatchReservation,
  type GlobalConfig,
  type LinearWriter,
  type LoopId,
  type LoopMode,
  type LoopSnapshot,
  type ResolvedRepoEntry,
  type RunState,
} from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import { buildSnapshot, type WorkerSnapshotInput } from "./snapshot.ts";
import type { BlockedItem, BoardCounts, ProposalItem, QueueItem } from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./workers/types.ts";
import { effectiveMode, type StageName } from "./routing.ts";
import { applyPendingDecisions } from "./workers/decisions.ts";

function isStageName(name: string): name is StageName {
  return name === "plan" || name === "refine" || name === "implement" || name === "review";
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  return { promise, cancel: () => clearTimeout(timer) };
}

interface LinearHealth {
  ok: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  requests: number;
}

/** Wraps every Linear call to record health for `status.json` without changing the writer interface. */
function trackLinearHealth(linear: LinearWriter, health: LinearHealth, now: () => Date): LinearWriter {
  const record = (error?: unknown): void => {
    health.requests += 1;
    health.lastPollAt = now().toISOString();
    if (error === undefined) {
      health.ok = true;
      health.lastError = null;
      return;
    }
    health.ok = false;
    if (error instanceof LinearApiError && error.status === 429) {
      health.lastError = `rate limited: ${error.message}`;
    } else {
      health.lastError = `outage: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return new Proxy(linear, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          const result = await value.apply(target, args);
          record();
          return result;
        } catch (error) {
          record(error);
          throw error;
        }
      };
    },
  });
}

// ---- singleton lockfile (SPEC §17.4) -------------------------------------

export interface LoopLockInfo {
  pid: number;
  startedAt: string;
  /** Unique per `acquire()` call (SPEC §17.4): the only way `release()` can tell "my lock" from a lock a later reclaim replaced it with. */
  token: string;
}

export class LoopLockHeldError extends Error {
  constructor(info: LoopLockInfo, path: string) {
    super(`a foreman process is already running (pid ${info.pid}, started ${info.startedAt}). Lock file: ${path}`);
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
 *
 * Reclaiming a stale lock never unlinks: two supervisors observing the same
 * dead holder could otherwise each unlink whatever is at the path —
 * including the other's just-written fresh lock — and both end up believing
 * they hold it. The reclaim write is instead an atomic rename, and each
 * `acquire()` mints a random `token`; `release()` only unlinks the file when
 * its on-disk token still matches this instance's, so a departing loser
 * never deletes the winner's lock.
 */
export class SupervisorLock {
  readonly #path: string;
  #acquired = false;
  #token: string | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  acquire(pid: number, now: Date, probe: ProcessProbe = nodeProcessProbe): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const token = randomUUID();
    const info: LoopLockInfo = { pid, startedAt: now.toISOString(), token };
    try {
      writeFileSync(this.#path, JSON.stringify(info, null, 2), { encoding: "utf8", flag: "wx" });
      this.#acquired = true;
      this.#token = token;
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }

    let existing: LoopLockInfo | null = null;
    try {
      existing = JSON.parse(readFileSync(this.#path, "utf8")) as LoopLockInfo;
    } catch {
      // A truncated lock cannot prove a live owner. Treat it like any stale
      // lock and retry the reclaim below.
    }
    if (existing && probe.isAlive(existing.pid)) throw new LoopLockHeldError(existing, this.#path);

    // Reclaim only after deciding the observed owner is stale. Atomic
    // replace (write to a token-suffixed temp path, then rename onto the
    // real path) rather than unlink-then-write: an unlink here would race a
    // concurrent reclaimer straight into deleting whichever process wrote
    // its fresh lock first.
    const tempPath = `${this.#path}.${token}`;
    writeFileSync(tempPath, JSON.stringify(info, null, 2), "utf8");
    renameSync(tempPath, this.#path);
    this.#acquired = true;
    this.#token = token;
  }

  release(): void {
    if (this.#acquired) {
      try {
        const current = JSON.parse(readFileSync(this.#path, "utf8")) as LoopLockInfo;
        if (current.token === this.#token) unlinkSync(this.#path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          // Corrupt or unreadable: nothing safe to compare the token
          // against, so leave whatever is on disk alone rather than guess.
        }
      }
    }
    this.#acquired = false;
    this.#token = null;
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
  log(`${style("yellow", "!")} herdr unavailable; falling back to PrintDispatcher.`);
  return factory.createPrint();
}

// ---- supervisor -----------------------------------------------------------

export interface SupervisorOptions {
  config: GlobalConfig;
  linear: LinearWriter;
  dispatcher: Dispatcher;
  /** Print dispatcher used when herdr becomes unreachable mid-run (SPEC §17.2). */
  printDispatcher?: Dispatcher;
  bookkeeping: Bookkeeping;
  stateDir: string;
  entry: ResolvedRepoEntry;
  /** Directory of per-agent dispatch-id reservation files (SPEC §17.4) — `loopPaths(...).reservations`. */
  reservationsDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  confirmer: Confirmer;
  /** This loop's control-plane identity (contract §I/§J): who `status.json` and every broadcast event say they are. */
  loopId: LoopId;
  statusPath: string | null;
  version: string;
  team: string | null;
  /** `--verbose`: emits per-tick timing, dispatch handle detail, reconcile counts, full error stacks, and per-item skip reasons that the default output omits — only actual dispatches and would-dispatch decisions log unconditionally. */
  verbose?: boolean;
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
  readonly #printDispatcher: Dispatcher | null;
  readonly #entry: ResolvedRepoEntry;
  readonly #reservationsDir: string;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #bookkeeping: Bookkeeping;
  readonly #lock: SupervisorLock;
  readonly #loopId: LoopId;
  readonly #statusPath: string | null;
  readonly #version: string;
  readonly #team: string | null;
  readonly #startedAt: string;
  readonly #confirmer: Confirmer;
  readonly #verbose: boolean;

  #runState: RunState = "starting";
  #pausedAt: string | null = null;
  #ticks = 0;
  #lastTickAt: string | null = null;
  #wake: (() => void) | null = null;
  #tickRequest: readonly string[] | null | undefined = undefined;
  #stopMode: "graceful" | "now" | null = null;
  #stopped = false;
  #fellBackFromHerdr = false;

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
    this.#now = options.now ?? (() => new Date());
    this.#linear = trackLinearHealth(options.linear, this.#linearHealth, this.#now);
    this.#dispatcher = options.dispatcher;
    this.#printDispatcher = options.printDispatcher ?? null;
    this.#bookkeeping = options.bookkeeping;
    this.#entry = options.entry;
    this.#reservationsDir = options.reservationsDir;
    const writeLog = options.log ?? ((message: string) => console.log(`[foreman-repo] ${message}`));
    this.#log = (message) => {
      writeLog(message);
      this.#emit({ event: "log", level: "info", line: message });
    };
    this.#lock = new SupervisorLock(lockPathFor(options.stateDir));
    this.#loopId = options.loopId;
    this.#statusPath = options.statusPath;
    this.#version = options.version;
    this.#team = options.team;
    this.#startedAt = this.#now().toISOString();
    this.#confirmer = options.confirmer;
    this.#verbose = options.verbose ?? false;
  }

  /** `--verbose` only: under-the-hood detail (timings, request tracing, dispatch handles, full stacks) the default output omits. */
  #logVerbose(message: string): void {
    if (!this.#verbose) return;
    this.#log(style("dim", `  · ${message}`));
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

  #fallbackFromHerdr(): Dispatcher {
    if (this.#dispatcher.kind !== "herdr") return this.#dispatcher;
    if (!this.#printDispatcher) {
      throw new Error("herdr unavailable and no print dispatcher configured for fallback");
    }
    if (!this.#fellBackFromHerdr) {
      this.#fellBackFromHerdr = true;
      this.#log("herdr unavailable; falling back to print dispatcher for remainder of this run");
    }
    return this.#printDispatcher;
  }

  async #dispatchWithFallback<T>(fn: (dispatcher: Dispatcher) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#dispatcher);
    } catch (error) {
      if (!isHerdrUnavailable(error)) throw error;
      return fn(this.#fallbackFromHerdr());
    }
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

  /** Every handle sharing `dispatchId`'s `batchId` — killing a print dispatch's single process kills every item in its batch (SPEC §17.4). */
  handlesInBatch(dispatchId: string): DispatchHandle[] {
    const handle = this.#handles.get(dispatchId);
    if (!handle) return [];
    return [...this.#handles.values()].filter((candidate) => candidate.batchId === handle.batchId);
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
    const liveDispatchIds = new Set<string>();
    await Promise.all(
      [...this.#handles.values()].map(async (handle) => {
        const status = await this.#dispatcher.status(handle);
        if (status === "starting" || status === "running") liveDispatchIds.add(handle.dispatchId);
      }),
    );
    this.#bookkeeping.reconcile(liveIssueIds, liveDispatchIds, this.#now(), lockTtlMs(this.#config()));
    this.#logVerbose(
      `reconcile: ${running.length} issue(s) carrying agent:running, ${liveDispatchIds.size} of ${this.#handles.size} tracked handle(s) still live`,
    );
    const dropped = before - this.#bookkeeping.state.inFlight.length;
    if (dropped > 0) {
      this.#log(`reconciled: dropped ${dropped} stale in-flight record(s)`);
    }
    try {
      this.#bookkeeping.save();
    } catch (error) {
      this.#log(`failed to save bookkeeping: ${String(error)}`);
    }
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
    if (!this.#statusPath) return;
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

  /**
   * Wakes the poll wait immediately in both modes: `#interruptibleWait`
   * already re-checks `draining` on entry, so a graceful stop that arrives
   * mid-wait must not sit until the next `pollMs` elapses just to notice it
   * — `runForever`'s loop-top check handles "finish the current tick first"
   * on its own; this only shortens the *wait between* ticks.
   */
  requestStop(mode: "graceful" | "now"): void {
    this.#stopMode = mode;
    this.#runState = "draining";
    if (mode === "now") {
      this.#log("stop requested (now): aborting between workers; in-flight dispatches rely on lock TTL");
    }
    this.#emit({ event: "state", runtime: this.snapshot().runtime });
    this.#wake?.();
  }

  setMode(mode: LoopMode): void {
    this.#config0.current = { ...this.#config(), loop: { ...this.#config().loop, mode } };
    this.publishStatus();
  }

  reloadConfig(config: GlobalConfig): void {
    this.#config0.current = config;
    this.publishStatus();
  }
  #context(workerName = ""): WorkerContext {
    const stage = isStageName(workerName) ? workerName : null;
    const config = this.#config();
    return {
      config,
      bookkeeping: this.#bookkeeping,
      dispatcher: this.#wrappedDispatcher(),
      linear: this.#linear,
      entry: this.#entry,
      now: this.#now,
      log: this.#log,
      mode: stage ? effectiveMode(stage, config.loop) : config.loop.mode,
      confirm: (request) => this.#confirmer.confirm(request),
      watchSettle: (handles, workerStage) => this.#watchSettle(handles, workerStage),
    };
  }

  /**
   * Observes a launched dispatch to completion in the background (SPEC
   * §17.8): a child that exits non-zero, fails its gate, or yields invalid
   * output must still reach the retry cap, not be silently re-dispatched
   * forever with the attempt count stuck at zero. Never awaited inside a
   * tick — `void`-started so `runTick` returns without waiting on the
   * dispatch to finish.
   */
  #watchSettle(handles: readonly DispatchHandle[], stage: StageName): void {
    const first = handles[0];
    if (!first) return;
    void (async () => {
      try {
        const outcome = await this.#dispatcher.settle(first);
        this.#logVerbose(
          `settled batch ${first.batchId} (${handles.length} item(s), ${first.agent}): status=${outcome.status} exitCode=${outcome.exitCode ?? "null"}`,
        );
        if (outcome.status !== "settled" || (outcome.exitCode ?? 0) !== 0) {
          for (const handle of handles) {
            const pending = this.#bookkeeping.recordAttemptFailure(
              stage,
              handle.issueId ?? "",
              this.#config().loop.retryCap,
              this.#now(),
            );
            if (pending) await applyPendingDecisions(this.#context(), [pending]);
          }
        }
      } catch (error) {
        this.#log(`watchSettle failed for batch ${first.batchId}: ${String(error)}`);
        if (this.#verbose && error instanceof Error && error.stack) this.#logVerbose(error.stack);
      } finally {
        for (const handle of handles) {
          this.#bookkeeping.clearDispatch(handle.dispatchId);
          this.forgetHandle(handle.dispatchId);
        }
        try {
          this.#bookkeeping.save();
        } catch (error) {
          this.#log(`failed to save bookkeeping: ${String(error)}`);
        }
      }
    })();
  }

  /**
   * Wraps the real dispatcher so every dispatch this process makes lands in
   * `#handles`/`#statuses` — the only way the supervisor can later report a
   * `DispatchHandle`'s `pid`/`herdr` pane, since workers call `dispatch()`
   * directly and never hand the handle back beyond what `Bookkeeping`
   * already stores (agent/issueId/dispatchId/startedAt/stage, no pane info).
   *
   * Also where reservations are written (SPEC §17.4, §11): a shared
   * orchestrator's session environment can't carry a per-item dispatch id,
   * so the loop writes one `DispatchReservation` per item to the file the
   * dispatched session's task guard reads, keyed by subject — before the
   * spawn itself, so the reservation is on disk before the agent's first
   * turn could possibly read it.
   */
  #wrappedDispatcher(): Dispatcher {
    const inner = this.#dispatcher;
    return {
      kind: inner.kind,
      dispatch: async (request) => {
        const now = this.#now();
        const entries: DispatchReservation[] = request.items.map((item) => ({
          agent: request.agent,
          subject: item.subject ?? BATCH_SUBJECT,
          dispatchId: item.dispatchId,
          reservedAt: now.toISOString(),
        }));
        reserveDispatches(
          reservationsPath(this.#reservationsDir, request.agent),
          entries,
          now,
          lockTtlMs(this.#config()),
        );
        const handles = await this.#dispatchWithFallback((dispatcher) => dispatcher.dispatch(request));
        for (const handle of handles) {
          this.#handles.set(handle.dispatchId, handle);
          this.#statuses.set(handle.dispatchId, "starting");
          this.#logVerbose(
            `dispatch ${handle.dispatchId} (${handle.agent}): cwd=${request.cwd} ` +
              (handle.herdr ? `pane=${handle.herdr.paneId}` : `pid=${handle.pid ?? "unknown"}`) +
              ` command="${request.command}"`,
          );
        }
        return handles;
      },
      status: (handle) => this.#dispatchWithFallback((dispatcher) => dispatcher.status(handle)),
      settle: (handle) => this.#dispatchWithFallback((dispatcher) => dispatcher.settle(handle)),
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
      // Pause/stop must take effect mid-tick, but a directly-invoked tick (tests,
      // the control plane's `tick`) may run before `start()` flips "starting" to
      // "running" — only an operator-requested halt should cut the tick short.
      const runState = this.#currentRunState();
      if (runState === "paused" || runState === "stopped") break;
      if (runState === "draining" && this.#stopMode === "now") break;
      this.#workerMeta.set(worker.name, { cadenceMs: worker.cadenceMs });
      const beforeIds = new Set(this.#bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
      this.#runningWorkers.add(worker.name);
      let report: WorkerReport;
      const workerStartedAt = performance.now();
      try {
        report = await worker.run(this.#context(worker.name));
        const stage = isStageName(worker.name) ? worker.name : null;
        const mode = stage ? effectiveMode(stage, this.#config().loop) : this.#config().loop.mode;
        const launched = new Set(report.dispatched);
        this.#log(
          `${worker.name} [mode: ${mode}]: ${style("green", `${report.dispatched.length} dispatched`)}, ` +
            `${style("yellow", `${report.decisions.length - report.dispatched.length} would dispatch`)}, ${report.skipped.length} skipped` +
            (report.errors.length > 0 ? `, ${style("red", `${report.errors.length} error(s)`)}` : ""),
        );
        this.#logVerbose(`${worker.name}: ran in ${Math.round(performance.now() - workerStartedAt)}ms`);
        for (const decision of report.decisions) {
          const dispatched = launched.has(decision);
          const action = dispatched ? "dispatched" : "would dispatch";
          const marker = dispatched ? style("green", "✓") : style("yellow", "~");
          this.#log(
            `  ${marker} ${action} ${worker.name} [mode: ${mode}] ${decision.issueId ?? decision.projectId ?? "(batch)"}: ${decision.reason}`,
          );
        }
        if (this.#verbose) {
          for (const skip of report.skipped) {
            this.#log(
              `  ${style("dim", "○")} skip ${worker.name} [mode: ${mode}] ${skip.issueId ?? skip.projectId ?? "(batch)"}: ${skip.code} — ${skip.message}`,
            );
          }
        }
      } catch (error) {
        this.#log(`${style("red", "✗")} ${worker.name} failed: ${String(error)}`);
        if (this.#verbose && error instanceof Error && error.stack) this.#logVerbose(error.stack);
        report = {
          worker: worker.name as WorkerReport["worker"],
          ranAt: this.#now().toISOString(),
          decisions: [],
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
      try {
        this.#bookkeeping.save();
      } catch (error) {
        this.#log(`failed to save bookkeeping: ${String(error)}`);
      }

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
        // A "tick now" that arrives while paused must not run — and must not be
        // left pending, or `#interruptibleWait`'s early-return would spin this
        // loop without ever yielding to the timer. Discard it; the operator
        // re-requests after resume.
        this.#tickRequest = undefined;
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
    if (this.#tickRequest !== undefined || this.#currentRunState() === "draining") return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#wake = resolve;
    const timer = sleep(ms);
    await Promise.race([promise, timer.promise]);
    timer.cancel();
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
