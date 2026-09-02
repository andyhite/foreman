import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Comment,
  Confirmer,
  CreateIssueInput,
  Dispatcher,
  DispatchHandle,
  DispatchOutcome,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
  Issue,
  IssueLabel,
  IssueQuery,
  LinearWriter,
  LoopMode,
  ResolvedRepoEntry,
  ControlEvent,
} from "@foreman/core";
import { DENY_CONFIRMER, repoLoopId, YOLO_CONFIRMER } from "@foreman/core";
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

function makeConfig(mode: LoopMode = "confirm"): GlobalConfig {
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
      mode,
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
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

  it("a reclaimed stale lock carries a token distinct from the dead holder's", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const dead: ProcessProbe = { isAlive: () => false };

    const first = new SupervisorLock(path);
    first.acquire(111, now, dead);
    const firstInfo = JSON.parse(readFileSync(path, "utf8")) as { token: string };

    const second = new SupervisorLock(path);
    second.acquire(222, now, dead);
    const secondInfo = JSON.parse(readFileSync(path, "utf8")) as { token: string };

    expect(secondInfo.token).not.toBe(firstInfo.token);
  });

  it("release never deletes a lock file whose token no longer matches this instance's own acquire — a departing loser must not delete the winner's lock", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");

    const loser = new SupervisorLock(path);
    loser.acquire(111, now, { isAlive: () => true });
    expect(existsSync(path)).toBe(true);

    // Simulate a second supervisor reclaiming the same path (both observed
    // the same stale holder, then both wrote a fresh lock) by overwriting
    // the file with a different token, as `winner`'s own acquire would.
    writeFileSync(
      path,
      JSON.stringify({ pid: 222, startedAt: now.toISOString(), token: "winner-token" }, null, 2),
      "utf8",
    );

    loser.release();

    expect(existsSync(path)).toBe(true);
    const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number; token: string };
    expect(info.pid).toBe(222);
    expect(info.token).toBe("winner-token");
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

/** Confirms via `ctx.confirm` before dispatching one decision; always skips a second issue with a fixed code. */
function makeStubWorker(): Worker {
  return {
    name: "refine",
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      const decision = { agent: "foreman-refine" as const, issueId: "ENG-1", command: "/foreman-refine ENG-1", reason: "Backlog, priority 1." };
      const approved = await ctx.confirm({ kind: "dispatch", summary: "dispatch foreman-refine for ENG-1" });
      return {
        worker: "refine",
        ranAt: ctx.now().toISOString(),
        decisions: [decision],
        dispatched: approved ? [decision] : [],
        skipped: [{ stage: "refine", issueId: "ENG-2", code: "unprioritized", message: "Priority is None." }],
        errors: [],
      };
    },
  };
}

function makeSupervisor(logs: string[], confirmer: Confirmer = YOLO_CONFIRMER, verbose = false): Supervisor {
  const stateDir = tempStateDir();
  return new Supervisor({
    config: makeConfig("yolo"),
    linear: new NoopLinear() as unknown as LinearWriter,
    dispatcher: new FakeDispatcher("print", true),
    bookkeeping: Bookkeeping.load(join(stateDir, "bookkeeping.json")),
    stateDir,
    entry: makeEntry(),
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: (message) => logs.push(message),
    confirmer,
    loopId: repoLoopId("acme"),
    statusPath: join(stateDir, "status.json"),
    version: "0.1.0-test",
    team: "ENG",
    verbose,
  });
}

describe("Supervisor.runTick — decision observability", () => {
  it("logs actual dispatches without per-item skip detail by default", async () => {
    const logs: string[] = [];
    const supervisor = makeSupervisor(logs);
    await supervisor.runTick([makeStubWorker()]);
    expect(logs.some((line) => line.includes("mode: yolo") && line.includes("1 dispatched"))).toBe(true);
    expect(logs.some((line) => line.includes("dispatched refine [mode: yolo] ENG-1"))).toBe(true);
    expect(logs.some((line) => line.includes("skip refine [mode: yolo] ENG-2: unprioritized"))).toBe(false);
  });

  it("logs every skip under --verbose", async () => {
    const logs: string[] = [];
    const supervisor = makeSupervisor(logs, YOLO_CONFIRMER, true);
    await supervisor.runTick([makeStubWorker()]);
    expect(logs.some((line) => line.includes("skip refine [mode: yolo] ENG-2: unprioritized"))).toBe(true);
  });

  it("publishes decision logs to control subscribers, including skip detail under verbose", async () => {
    const supervisor = makeSupervisor([], YOLO_CONFIRMER, true);
    const events: ControlEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    await supervisor.runTick([makeStubWorker()]);
    expect(events.some((event) => event.event === "log" && event.line.includes("ENG-1"))).toBe(true);
    expect(events.some((event) => event.event === "log" && event.line.includes("unprioritized"))).toBe(true);
  });

  it("a denying confirmer produces no dispatch; YOLO_CONFIRMER dispatches", async () => {
    const deniedLogs: string[] = [];
    const deniedSupervisor = makeSupervisor(deniedLogs, DENY_CONFIRMER);
    await deniedSupervisor.runTick([makeStubWorker()]);
    expect(deniedLogs.some((line) => line.includes("would dispatch refine [mode: yolo] ENG-1"))).toBe(true);
    expect(deniedSupervisor.snapshot().history.dispatchesPerTick.at(-1)).toBe(0);

    const yoloLogs: string[] = [];
    const yoloSupervisor = makeSupervisor(yoloLogs, YOLO_CONFIRMER);
    await yoloSupervisor.runTick([makeStubWorker()]);
    expect(yoloLogs.some((line) => line.includes("dispatched refine [mode: yolo] ENG-1"))).toBe(true);
    expect(yoloSupervisor.snapshot().history.dispatchesPerTick.at(-1)).toBe(1);
  });

  it("setMode(\"yolo\") flips snapshot().runtime.mode", () => {
    const supervisor = makeSupervisor([]);
    expect(supervisor.snapshot().runtime.mode).toBe("yolo");
    supervisor.setMode("confirm");
    expect(supervisor.snapshot().runtime.mode).toBe("confirm");
    supervisor.setMode("yolo");
    expect(supervisor.snapshot().runtime.mode).toBe("yolo");
  });
});

// ---- watchSettle / retry cap (SPEC §17.8) ---------------------------------

/** Dispatches once per `run()` call and hands the handle to `watchSettle`, mirroring the real workers. */
function makeDispatchAndWatchWorker(): Worker {
  let seq = 0;
  return {
    name: "implement",
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      seq += 1;
      const dispatchId = `foreman-implement-ENG-1-2026060${seq}T120000Z-abc`;
      const handle = await ctx.dispatcher.dispatch({
        agent: "foreman-implement",
        issueId: "ENG-1",
        command: "/foreman:implement ENG-1",
        dispatchId,
        cwd: ctx.entry.repoPath,
      });
      ctx.bookkeeping.recordDispatch({
        agent: "foreman-implement",
        issueId: "ENG-1",
        dispatchId: handle.dispatchId,
        startedAt: handle.startedAt,
        stage: "implement",
      });
      ctx.watchSettle(handle, "implement");
      return {
        worker: "implement",
        ranAt: ctx.now().toISOString(),
        decisions: [],
        dispatched: [],
        skipped: [],
        errors: [],
      };
    },
  };
}

/** Settles every dispatch with a fixed exit code, exercised by `Supervisor#watchSettle`. */
class SettlingDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  constructor(private readonly exitCode: number) {}

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
    return { handle, status: "settled", exitCode: this.exitCode, log: "" };
  }
  async available(): Promise<boolean> {
    return true;
  }
}

/** Minimal `LinearWriter` sufficient for `applyPendingDecisions` to run against one fixed issue. */
class DecisionLinear implements Partial<LinearWriter> {
  updateCalls: unknown[] = [];
  commentCalls: unknown[] = [];

  async issue(): Promise<Issue> {
    return {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Some issue",
      description: "",
      priority: 2,
      estimate: 2,
      url: "https://linear.app/issue/ENG-1",
      branchName: "eng-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      state: { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
      labels: [],
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      project: { id: "proj-1", name: "Project" },
      parent: null,
      children: [],
      assignee: null,
      relations: [],
      comments: [],
    };
  }
  async ensureLabel(name: string): Promise<IssueLabel> {
    return { id: `label-${name}`, name, parentId: null };
  }
  async updateIssue(issueId: string, input: unknown): Promise<Issue> {
    this.updateCalls.push({ issueId, input });
    return this.issue();
  }
  async createComment(input: { issueId: string; body: string }): Promise<Comment> {
    this.commentCalls.push(input);
    return { id: "comment-1", body: input.body, createdAt: new Date().toISOString(), user: null, parentId: null };
  }
  async issues(_query: IssueQuery): Promise<Issue[]> {
    return [];
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not used in this test");
  }
}

async function flushBackgroundWork(): Promise<void> {
  // `watchSettle` is started with `void` and never awaited by `runTick`; drain
  // its microtask chain (settle -> recordAttemptFailure -> applyPendingDecisions
  // -> clearDispatch/save) deterministically rather than racing a wall clock.
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("Supervisor#watchSettle (SPEC §17.8: agent failures must reach the retry cap)", () => {
  it("increments the attempt counter on a non-zero settle and, at the cap, converts to a pending decision", async () => {
    const stateDir = tempStateDir();
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const linear = new DecisionLinear();
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: linear as unknown as LinearWriter,
      dispatcher: new SettlingDispatcher(1),
      bookkeeping,
      stateDir,
      entry: makeEntry(),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: () => {},
      confirmer: YOLO_CONFIRMER,
      loopId: repoLoopId("acme"),
      statusPath: null,
      version: "0.1.0-test",
      team: "ENG",
    });

    const worker = makeDispatchAndWatchWorker();

    await supervisor.runTick([worker]);
    await flushBackgroundWork();
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(1);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);
    // The in-flight record is cleared once settle resolves, not held for the TTL.
    expect(bookkeeping.state.inFlight).toHaveLength(0);

    await supervisor.runTick([worker]);
    await flushBackgroundWork();
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(2);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);

    // retryCap defaults to 2 (makeConfig) — the third failure exceeds it.
    await supervisor.runTick([worker]);
    await flushBackgroundWork();
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(3);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(1);
    expect(bookkeeping.state.pendingDecisions[0]?.kind).toBe("retry-exhausted");
    expect(linear.updateCalls).toHaveLength(1);
    expect(linear.commentCalls).toHaveLength(1);
  });

  it("does not record an attempt failure on a clean (exitCode 0) settle", async () => {
    const stateDir = tempStateDir();
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const linear = new DecisionLinear();
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: linear as unknown as LinearWriter,
      dispatcher: new SettlingDispatcher(0),
      bookkeeping,
      stateDir,
      entry: makeEntry(),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: () => {},
      confirmer: YOLO_CONFIRMER,
      loopId: repoLoopId("acme"),
      statusPath: null,
      version: "0.1.0-test",
      team: "ENG",
    });

    await supervisor.runTick([makeDispatchAndWatchWorker()]);
    await flushBackgroundWork();
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(0);
    expect(bookkeeping.state.inFlight).toHaveLength(0);
  });
});
