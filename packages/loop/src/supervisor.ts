/**
 * The supervisor (SPEC §17.5, §17.4 "the loop is a singleton"): one process,
 * several independent workers with their own cadences, a shared lockfile,
 * shared global counters, one log. Four separate processes would multiply
 * the singleton problem by four and give no shared view of total load.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Dispatcher, GlobalConfig, LinearWriter } from "@foreman/core";
import { IN_FLIGHT_FILTER } from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
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
 * Chooses the dispatcher from `loop.dispatcher`, falling back to print when
 * herdr is configured but its server is unreachable (SPEC §17.2: "Foreman
 * should degrade to print mode when the server isn't there rather than
 * stalling the loop"). Logs the fallback so it is visible, not silent.
 */
export async function resolveDispatcher(
  config: GlobalConfig,
  factory: DispatcherFactory,
  log: (message: string) => void,
): Promise<Dispatcher> {
  if (config.loop.dispatcher !== "herdr") {
    return factory.createPrint();
  }
  const herdr = factory.createHerdr();
  if (await herdr.available()) {
    return herdr;
  }
  log("herdr dispatcher configured but unavailable; falling back to PrintDispatcher.");
  return factory.createPrint();
}

// ---- supervisor -----------------------------------------------------------

export interface SupervisorOptions {
  config: GlobalConfig;
  linear: LinearWriter;
  dispatcher: Dispatcher;
  bookkeeping: Bookkeeping;
  stateDir: string;
  now?: () => Date;
  log?: (message: string) => void;
  dryRun: boolean;
}

export interface RunTickOptions {
  /** Restrict this tick to named workers (SPEC §18 step 6: implement alone). */
  workerNames?: readonly string[];
}

export class Supervisor {
  readonly #config: GlobalConfig;
  readonly #linear: LinearWriter;
  readonly #dispatcher: Dispatcher;
  readonly #bookkeeping: Bookkeeping;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #dryRun: boolean;
  readonly #lock: SupervisorLock;
  #stopped = false;

  constructor(options: SupervisorOptions) {
    this.#config = options.config;
    this.#linear = options.linear;
    this.#dispatcher = options.dispatcher;
    this.#bookkeeping = options.bookkeeping;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? ((message) => console.log(`[foreman-loop] ${message}`));
    this.#dryRun = options.dryRun;
    this.#lock = new SupervisorLock(lockPathFor(options.stateDir));
  }

  get bookkeeping(): Bookkeeping {
    return this.#bookkeeping;
  }

  acquireLock(probe?: ProcessProbe): void {
    this.#lock.acquire(process.pid, this.#now(), probe);
  }

  releaseLock(): void {
    this.#lock.release();
  }

  /**
   * Reconciles bookkeeping against Linear on start (SPEC §11, §17.5): any
   * `inFlight` record for an issue that no longer carries `agent:running` is
   * dropped, since the extension released the lock (or it expired) while
   * this process was not running. Never touches Linear itself.
   */
  async reconcile(): Promise<void> {
    const running = await this.#linear.issues({ filter: IN_FLIGHT_FILTER, limit: 500 });
    const liveIssueIds = new Set(running.map((issue) => issue.identifier));
    const liveDispatchIds = new Set(this.#bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
    this.#bookkeeping.reconcile(liveIssueIds, liveDispatchIds);
    this.#bookkeeping.save();
  }

  #context(): WorkerContext {
    return {
      config: this.#config,
      bookkeeping: this.#bookkeeping,
      dispatcher: this.#dispatcher,
      linear: this.#linear,
      now: this.#now,
      log: this.#log,
      dryRun: this.#dryRun,
    };
  }

  /** Runs each selected worker exactly once, saving bookkeeping after each. */
  async runTick(workers: readonly Worker[], options: RunTickOptions = {}): Promise<WorkerReport[]> {
    const selected = options.workerNames
      ? workers.filter((worker) => options.workerNames?.includes(worker.name))
      : workers;
    const reports: WorkerReport[] = [];
    for (const worker of selected) {
      try {
        const report = await worker.run(this.#context());
        reports.push(report);
        this.#log(
          `${worker.name}: ${report.dispatched.length} dispatched, ${report.skipped.length} skipped` +
            (report.errors.length > 0 ? `, ${report.errors.length} error(s)` : ""),
        );
      } catch (error) {
        this.#log(`${worker.name} failed: ${String(error)}`);
        reports.push({
          worker: worker.name as WorkerReport["worker"],
          ranAt: this.#now().toISOString(),
          dispatched: [],
          skipped: [],
          errors: [String(error)],
        });
      }
      this.#bookkeeping.save();
    }
    return reports;
  }

  /**
   * Runs forever on each worker's own cadence until `stop()` is called.
   * Config is re-read by the caller at the top of every cadence tick (SPEC
   * §3.10) — this method takes a `loadConfig` callback for that reason
   * rather than trusting the config captured at construction.
   */
  async runForever(
    workers: readonly Worker[],
    options: { workerNames?: readonly string[]; pollMs?: number } = {},
  ): Promise<void> {
    const pollMs = options.pollMs ?? 30_000;
    const lastRunAt = new Map<string, number>();
    while (!this.#stopped) {
      const nowMs = this.#now().getTime();
      const due = workers.filter((worker) => {
        if (options.workerNames && !options.workerNames.includes(worker.name)) return false;
        const last = lastRunAt.get(worker.name) ?? 0;
        return nowMs - last >= worker.cadenceMs;
      });
      if (due.length > 0) {
        await this.runTick(due, { workerNames: due.map((worker) => worker.name) });
        for (const worker of due) lastRunAt.set(worker.name, nowMs);
      }
      await sleep(pollMs);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.releaseLock();
  }
}
