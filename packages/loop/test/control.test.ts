import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import { Bookkeeping } from "../src/bookkeeping.ts";
import { createControlHandlers } from "../src/control.ts";
import { Supervisor } from "../src/supervisor.ts";
import type { Worker, WorkerContext, WorkerReport } from "../src/workers/types.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-control-"));
}

/** Mirrors `FakeDispatcher` in `supervisor.test.ts` — never implements `attach`, matching a real `PrintDispatcher`. */
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
      pid: 4242,
      herdr: null,
    };
  }

  async status(): Promise<DispatchStatus> {
    return "running";
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
      stage: "full",
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

/** Dispatches exactly one decision each run, so a test can count dispatches via `bookkeeping.totalInFlight()`. */
function makeDispatchingWorker(name = "refine"): Worker {
  let counter = 0;
  return {
    name,
    cadenceMs: 0,
    async run(ctx: WorkerContext): Promise<WorkerReport> {
      counter += 1;
      const issueId = `ENG-${counter}`;
      const dispatchId = `d-${counter}`;
      const handle = await ctx.dispatcher.dispatch({
        agent: "foreman-refine",
        issueId,
        command: `/foreman-refine ${issueId}`,
        dispatchId,
        cwd: ctx.entry.repoPath,
      });
      ctx.bookkeeping.recordDispatch({
        agent: "foreman-refine",
        issueId,
        dispatchId: handle.dispatchId,
        startedAt: handle.startedAt,
        stage: "refine",
      });
      return {
        worker: "refine",
        ranAt: ctx.now().toISOString(),
        dispatched: [{ agent: "foreman-refine", issueId, command: `/foreman-refine ${issueId}`, reason: "test" }],
        skipped: [],
        errors: [],
      };
    },
  };
}

function makeSupervisor(dispatcher: Dispatcher = new FakeDispatcher("print", true)): Supervisor {
  const stateDir = tempStateDir();
  return new Supervisor({
    config: makeConfig(),
    linear: new NoopLinear() as unknown as LinearWriter,
    dispatcher,
    bookkeeping: Bookkeeping.load(join(stateDir, "bookkeeping.json")),
    stateDir,
    entry: makeEntry(),
    now: () => new Date(),
    log: () => {},
    dryRun: false,
    loopId: "repo:product",
    statusPath: join(stateDir, "status.json"),
    version: "0.1.0",
    team: "ENG",
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createControlHandlers — delegation", () => {
  it("snapshot/setStage/stop delegate straight to the supervisor", () => {
    const supervisor = makeSupervisor();
    supervisor.acquireLock();
    const handlers = createControlHandlers({ supervisor });

    expect(handlers.snapshot()).toEqual(supervisor.snapshot());

    handlers.setStage("read-only");
    expect(supervisor.snapshot().runtime.stage).toBe("read-only");

    handlers.stop("graceful");
    expect(supervisor.runState).toBe("draining");
  });

  it("pause/resume delegate and are reflected in runState", () => {
    const supervisor = makeSupervisor();
    supervisor.acquireLock();
    const handlers = createControlHandlers({ supervisor });

    handlers.pause();
    expect(supervisor.runState).toBe("paused");
    handlers.resume();
    expect(supervisor.runState).toBe("running");
  });
});

describe("Supervisor pause/requestTick interaction", () => {
  it("pause then requestTick does not dispatch until resumed", async () => {
    const supervisor = makeSupervisor();
    supervisor.acquireLock();
    const worker = makeDispatchingWorker();

    // Pause before the loop starts, so its very first iteration sees "paused"
    // rather than racing a same-tick dispatch against `pause()`.
    supervisor.pause();
    const done = supervisor.runForever([worker], { pollMs: 20 });
    supervisor.requestTick();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(supervisor.bookkeeping.totalInFlight()).toBe(0);

    supervisor.resume();
    supervisor.requestTick();
    await waitFor(() => supervisor.bookkeeping.totalInFlight() > 0);
    expect(supervisor.bookkeeping.totalInFlight()).toBe(1);

    supervisor.requestStop("now");
    await done;
  });

  it("requestTick shortcuts the poll wait instead of waiting the full pollMs", async () => {
    const supervisor = makeSupervisor();
    supervisor.acquireLock();
    const worker = makeDispatchingWorker();

    const done = supervisor.runForever([worker], { pollMs: 10_000 });
    const start = Date.now();
    supervisor.requestTick();
    await waitFor(() => supervisor.bookkeeping.totalInFlight() > 0, 1000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    supervisor.requestStop("now");
    await done;
  });
});

describe("createControlHandlers — attachAgent", () => {
  it("throws the documented message when the dispatcher is print mode", async () => {
    const supervisor = makeSupervisor(new FakeDispatcher("print", true));
    supervisor.acquireLock();
    const worker = makeDispatchingWorker();
    const [report] = await supervisor.runTick([worker]);
    const dispatchId = report?.dispatched[0]
      ? supervisor.bookkeeping.state.inFlight.find((entry) => entry.issueId === report.dispatched[0]?.issueId)?.dispatchId
      : undefined;
    expect(dispatchId).toBeDefined();

    const handlers = createControlHandlers({ supervisor });
    await expect(handlers.attachAgent(dispatchId as string)).rejects.toThrow(
      "print dispatcher has no pane to attach",
    );
  });
});
