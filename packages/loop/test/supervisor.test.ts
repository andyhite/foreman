import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Dispatcher,
  DispatchHandle,
  DispatchOutcome,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
  LinearWriter,
  ResolvedRepoEntry,
} from "@foreman/core";
import { repoLoopId } from "@foreman/core";
import { Bookkeeping } from "../src/bookkeeping.ts";
import {
  LoopLockHeldError,
  Supervisor,
  SupervisorLock,
  lockPathFor,
  resolveDispatcher,
  type ProcessProbe,
} from "../src/supervisor.ts";
import type { Worker, WorkerContext, WorkerReport } from "../src/workers/types.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-supervisor-"));
}

class FakeDispatcher implements Dispatcher {
  readonly kind: "print" | "herdr";
  #available: boolean;

  constructor(kind: "print" | "herdr", available: boolean) {
    this.kind = kind;
    this.#available = available;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle> {
    return {
      dispatchId: request.dispatchId,
      agent: request.agent,
      issueId: request.issueId,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: null,
    };
  }

  async status(): Promise<DispatchStatus> {
    return "settled";
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return { handle, status: "settled", exitCode: 0, log: "" };
  }

  async available(): Promise<boolean> {
    return this.#available;
  }
}

function makeConfig(): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      stage: "dry-run",
      mergeDetection: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20 },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql" },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr" },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

describe("SupervisorLock", () => {
  it("refuses a second holder while the first pid is live", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const alwaysAlive: ProcessProbe = { isAlive: () => true };

    const first = new SupervisorLock(path);
    first.acquire(111, now, alwaysAlive);
    expect(existsSync(path)).toBe(true);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, alwaysAlive)).toThrow(LoopLockHeldError);

    // The lock file still names the first holder — the second acquire never
    // clobbered it.
    const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(info.pid).toBe(111);
  });

  it("releases on shutdown, freeing the lock for the next holder", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const alwaysAlive: ProcessProbe = { isAlive: () => true };

    const first = new SupervisorLock(path);
    first.acquire(111, now, alwaysAlive);
    first.release();
    expect(existsSync(path)).toBe(false);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, alwaysAlive)).not.toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it("takes over a stale lock whose pid is dead", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const dead: ProcessProbe = { isAlive: () => false };

    const first = new SupervisorLock(path);
    first.acquire(111, now, dead);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, dead)).not.toThrow();

    const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(info.pid).toBe(222);
  });

  it("release is a no-op when the lock was never acquired by this instance", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const lock = new SupervisorLock(path);
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("resolveDispatcher", () => {
  it("uses herdr when available", async () => {
    const dispatcher = await resolveDispatcher(
      {
        createPrint: () => new FakeDispatcher("print", true),
        createHerdr: () => new FakeDispatcher("herdr", true),
      },
      () => {},
    );
    expect(dispatcher.kind).toBe("herdr");
  });

  it("falls back to print when herdr is unavailable, and logs the fallback", async () => {
    const logs: string[] = [];
    const dispatcher = await resolveDispatcher(
      {
        createPrint: () => new FakeDispatcher("print", true),
        createHerdr: () => new FakeDispatcher("herdr", false),
      },
      (message) => logs.push(message),
    );
    expect(dispatcher.kind).toBe("print");
    expect(logs.some((line) => line.toLowerCase().includes("herdr") && line.toLowerCase().includes("fall"))).toBe(true);
  });
});

/** Minimal `LinearWriter` stub: `runTick` never calls it directly, only the stub worker does. */
class NoopLinear implements Partial<LinearWriter> {}

function makeEntry(): ResolvedRepoEntry {
  return {
    alias: "product",
    repoPath: "/repos/product",
    team: "ENG",
    initiativeIds: ["initiative-1"],
    baseBranch: "main",
    pr: { required: true, draft: false, ciRequired: true },
    merge: { strategy: "squash", deleteBranch: true },
    branchPattern: "<issue-id>-<slug>",
    worktreePattern: "../<repo>-<ISSUE-ID>",
  };
}

/** Always dispatches one decision and skips one issue with a fixed code, for asserting log shape. */
function makeStubWorker(): Worker {
  return {
    name: "refine",
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      return {
        worker: "refine",
        ranAt: ctx.now().toISOString(),
        dispatched: [
          { agent: "foreman-refine", issueId: "ENG-1", command: "/foreman-refine ENG-1", reason: "Backlog, priority 1." },
        ],
        skipped: [{ stage: "refine", issueId: "ENG-2", code: "unprioritized", message: "Priority is None." }],
        errors: [],
      };
    },
  };
}

function makeSupervisor(verbose: boolean, logs: string[]): Supervisor {
  const stateDir = tempStateDir();
  return new Supervisor({
    config: makeConfig(),
    linear: new NoopLinear() as unknown as LinearWriter,
    dispatcher: new FakeDispatcher("print", true),
    bookkeeping: Bookkeeping.load(join(stateDir, "bookkeeping.json")),
    stateDir,
    entry: makeEntry(),
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: (message) => logs.push(message),
    dryRun: false,
    verbose,
    loopId: repoLoopId("acme"),
    statusPath: join(stateDir, "status.json"),
    version: "0.1.0-test",
    team: "ENG",
  });
}

describe("Supervisor.runTick — verbose skip logging (defect: --verbose was inert in continuous mode)", () => {
  it("always logs the dispatch count and per-decision dispatch lines, regardless of verbose", async () => {
    const logs: string[] = [];
    const supervisor = makeSupervisor(false, logs);
    await supervisor.runTick([makeStubWorker()]);
    expect(logs.some((line) => line.includes("refine: 1 dispatched, 1 skipped"))).toBe(true);
    expect(logs.some((line) => line.includes("→ refine ENG-1: Backlog, priority 1."))).toBe(true);
  });

  it("logs skip records when verbose is true", async () => {
    const logs: string[] = [];
    const supervisor = makeSupervisor(true, logs);
    await supervisor.runTick([makeStubWorker()]);
    expect(logs.some((line) => line.includes("skip refine ENG-2: unprioritized") || line.includes("skip refine ENG-2 unprioritized"))).toBe(true);
  });

  it("omits skip records when verbose is false, even in the same runTick call used by continuous mode", async () => {
    const logs: string[] = [];
    const supervisor = makeSupervisor(false, logs);
    await supervisor.runTick([makeStubWorker()]);
    expect(logs.some((line) => line.includes("unprioritized"))).toBe(false);
  });
});
