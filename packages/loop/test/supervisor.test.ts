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
import { DENY_CONFIRMER, readReservations, repoLoopId, reservationsPath, YOLO_CONFIRMER } from "@foreman/core";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { HerdrUnavailableError } from "../src/dispatch/index.ts";
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

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const batchId = `batch-${Math.random().toString(36).slice(2)}`;
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt: new Date().toISOString(),
      batchId,
      pid: null,
      herdr: null,
    }));
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
      claimGraceMs: 300_000,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      mode,
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, batchesPerDay: 1, timezone: "UTC" },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql", allowCustomEndpoint: false },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr", herdrLayout: "tab", orchestratorMaxBatches: 20 },
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
      const decision = { agent: "foreman-refine" as const, issueId: "ENG-1", subject: "ENG-1", command: "/foreman-refine ENG-1", reason: "Backlog, priority 1." };
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
    reservationsDir: join(stateDir, "reservations"),
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

  it("recordAgentReport logs each created title and the summary, and emits a report event", async () => {
    const supervisor = makeSupervisor([]);
    const events: ControlEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    supervisor.recordAgentReport({
      dispatchId: "foreman-plan-project-1-20260101T000000Z-abc123",
      agent: "foreman-plan",
      status: "applied",
      subject: "Auth revamp",
      summary: 'planned "Auth revamp": 1 issue(s)',
      created: [
        {
          kind: "issue",
          id: "issue-1",
          identifier: "ENG-142",
          title: "Add token refresh endpoint",
          url: "https://linear.app/x/issue/ENG-142",
        },
      ],
      movedTo: null,
    });
    expect(events.some((event) => event.event === "log" && event.line.includes("Add token refresh endpoint"))).toBe(true);
    expect(events.some((event) => event.event === "log" && event.line.includes('planned "Auth revamp"'))).toBe(true);
    expect(events.some((event) => event.event === "report")).toBe(true);
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
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: ctx.entry.repoPath,
        alias: "product",
        items: [{ issueId: "ENG-1", subject: "ENG-1", dispatchId, worktree: null }],
      });
      const handle = handles[0];
      if (!handle) throw new Error("no handle");
      ctx.bookkeeping.recordDispatch({
        agent: "foreman-implement",
        issueId: "ENG-1",
        dispatchId: handle.dispatchId,
        startedAt: handle.startedAt,
        stage: "implement",
      });
      ctx.watchSettle(handles, "implement");
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

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const batchId = `batch-${Math.random().toString(36).slice(2)}`;
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt: new Date().toISOString(),
      batchId,
      pid: null,
      herdr: null,
    }));
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
      reservationsDir: join(stateDir, "reservations"),
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
    // The decision is applied to Linear immediately, then drained from the
    // durable queue — it would otherwise duplicate the `blocked:needs-decision`
    // state Linear now records (B12).
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);
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
      reservationsDir: join(stateDir, "reservations"),
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

// ---- reservations / batched dispatch (SPEC §17.4, §11) --------------------

/** Dispatches a fixed 3-item batch in one request and hands every resulting handle to a single `watchSettle`. */
function makeBatchDispatchAndWatchWorker(): Worker {
  return {
    name: "refine",
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      const items = ["ENG-1", "ENG-2", "ENG-3"].map((issueId) => ({
        issueId,
        subject: issueId,
        dispatchId: `foreman-refine-${issueId}-batch`,
        worktree: null,
      }));
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-refine",
        command: "/foreman:refine",
        cwd: ctx.entry.repoPath,
        alias: ctx.entry.alias,
        items,
      });
      for (const handle of handles) {
        ctx.bookkeeping.recordDispatch({
          agent: "foreman-refine",
          issueId: handle.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "refine",
        });
      }
      ctx.watchSettle(handles, "refine");
      return {
        worker: "refine",
        ranAt: ctx.now().toISOString(),
        decisions: [],
        dispatched: [],
        skipped: [],
        errors: [],
      };
    },
  };
}

describe("Supervisor — reservations and batch settle (SPEC §17.4, §11)", () => {
  it("writes one DispatchReservation per item to the agent's reservations file before dispatching", async () => {
    const stateDir = tempStateDir();
    const reservationsDir = join(stateDir, "reservations");
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: new NoopLinear() as unknown as LinearWriter,
      dispatcher: new FakeDispatcher("print", true),
      bookkeeping,
      stateDir,
      reservationsDir,
      entry: makeEntry(),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: () => {},
      confirmer: YOLO_CONFIRMER,
      loopId: repoLoopId("acme"),
      statusPath: null,
      version: "0.1.0-test",
      team: "ENG",
    });

    await supervisor.runTick([makeBatchDispatchAndWatchWorker()]);

    const reservations = readReservations(reservationsPath(reservationsDir, "foreman-refine"));
    expect(reservations).toHaveLength(3);
    expect(reservations.map((entry) => entry.subject).sort()).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(reservations.every((entry) => entry.dispatchId.startsWith("foreman-refine-"))).toBe(true);
  });

  it("settling the batch once clears every in-flight record in it", async () => {
    const stateDir = tempStateDir();
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: new NoopLinear() as unknown as LinearWriter,
      dispatcher: new SettlingDispatcher(0),
      bookkeeping,
      stateDir,
      reservationsDir: join(stateDir, "reservations"),
      entry: makeEntry(),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: () => {},
      confirmer: YOLO_CONFIRMER,
      loopId: repoLoopId("acme"),
      statusPath: null,
      version: "0.1.0-test",
      team: "ENG",
    });

    await supervisor.runTick([makeBatchDispatchAndWatchWorker()]);
    await flushBackgroundWork();

    expect(bookkeeping.state.inFlight).toHaveLength(0);
    for (const issueId of ["ENG-1", "ENG-2", "ENG-3"]) {
      expect(supervisor.handleFor(`foreman-refine-${issueId}-batch`)).toBeNull();
    }
  });
});

// ---- herdr fallback routing (B1: paneless print handles must not be polled through herdr) ----

/** Herdr dispatcher whose `dispatch` always fails as "herdr unavailable"; its `settle`/`status` would report "lost" for any handle, proving `#dispatcherFor` must never hand it a print-mode handle. */
class UnavailableHerdrDispatcher implements Dispatcher {
  readonly kind = "herdr" as const;
  async dispatch(): Promise<DispatchHandle[]> {
    throw new HerdrUnavailableError("herdr server unreachable");
  }
  async status(): Promise<DispatchStatus> {
    return "lost";
  }
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return { handle, status: "lost", exitCode: null, log: "" };
  }
  async available(): Promise<boolean> {
    return false;
  }
}

/** Print dispatcher whose `settle` only resolves once `release()` is called, so the test can observe bookkeeping state before and after the settle resolves. */
class GatedPrintDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  statusCalls = 0;
  settleCalls = 0;
  #release: (() => void) | null = null;
  #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const batchId = `batch-${Math.random().toString(36).slice(2)}`;
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt: new Date().toISOString(),
      batchId,
      pid: 4242,
      herdr: null,
    }));
  }
  async status(): Promise<DispatchStatus> {
    this.statusCalls += 1;
    return "running";
  }
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    this.settleCalls += 1;
    await this.#gate;
    return { handle, status: "settled", exitCode: 0, log: "" };
  }
  async available(): Promise<boolean> {
    return true;
  }
}

describe("Supervisor — herdr-unavailable fallback routes settle/status to the print dispatcher (B1)", () => {
  it("never consults the herdr dispatcher's settle/status for a print-mode fallback handle, and keeps the in-flight record until the print settle resolves", async () => {
    const stateDir = tempStateDir();
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const linear = new DecisionLinear();
    const herdr = new UnavailableHerdrDispatcher();
    const print = new GatedPrintDispatcher();
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: linear as unknown as LinearWriter,
      dispatcher: herdr,
      printDispatcher: print,
      bookkeeping,
      stateDir,
      reservationsDir: join(stateDir, "reservations"),
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

    // The dispatch itself fell back to print (herdr.dispatch always throws),
    // and watchSettle is now blocked on the gated print settle — the herdr
    // dispatcher's settle/status (which would report "lost") must never have
    // been consulted, so no attempt failure is charged and the record survives.
    expect(print.settleCalls).toBe(1);
    expect(bookkeeping.state.inFlight).toHaveLength(1);
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(0);

    print.release();
    await flushBackgroundWork();

    // Once the print dispatcher's settle resolves cleanly, the record clears
    // and no attempt failure was ever recorded via the herdr path.
    expect(bookkeeping.state.inFlight).toHaveLength(0);
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(0);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);
  });
});

// ---- plan-batch accounting on failure (B12: issue-less handles must not be charged or produce empty-issue decisions) ----

/** Dispatches a single plan batch item with `issueId: null` (a project-scoped batch, not an issue), and hands the handle to `watchSettle`. */
function makePlanBatchWorker(): Worker {
  return {
    name: "plan",
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-plan",
        command: "/foreman:plan",
        cwd: ctx.entry.repoPath,
        alias: ctx.entry.alias,
        items: [{ issueId: null, subject: "initiative-1", dispatchId: "foreman-plan-batch-1", worktree: null }],
      });
      for (const handle of handles) {
        ctx.bookkeeping.recordDispatch({
          agent: "foreman-plan",
          issueId: handle.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "plan",
        });
      }
      ctx.watchSettle(handles, "plan");
      return {
        worker: "plan",
        ranAt: ctx.now().toISOString(),
        decisions: [],
        dispatched: [],
        skipped: [],
        errors: [],
      };
    },
  };
}

describe("Supervisor#watchSettle — issue-less plan batch on failure (B12)", () => {
  it("records no attempt failure and publishes no pending decision for a failed batch item with issueId: null", async () => {
    const stateDir = tempStateDir();
    const bookkeeping = Bookkeeping.load(join(stateDir, "bookkeeping.json"));
    const linear = new DecisionLinear();
    const supervisor = new Supervisor({
      config: makeConfig("yolo"),
      linear: linear as unknown as LinearWriter,
      dispatcher: new SettlingDispatcher(1),
      bookkeeping,
      stateDir,
      reservationsDir: join(stateDir, "reservations"),
      entry: makeEntry(),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: () => {},
      confirmer: YOLO_CONFIRMER,
      loopId: repoLoopId("acme"),
      statusPath: null,
      version: "0.1.0-test",
      team: "ENG",
    });

    await supervisor.runTick([makePlanBatchWorker()]);
    await flushBackgroundWork();

    // No issue to charge a retry against — the attempts map must not gain a
    // `plan:` (empty-issueId) entry, and no PendingDecision with an empty
    // issueId must ever be published for the TUI queue to display.
    expect(bookkeeping.attemptCount("plan", "")).toBe(0);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
    expect(bookkeeping.state.inFlight).toHaveLength(0);
  });
});
