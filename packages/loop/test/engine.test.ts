import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatcher, DispatchHandle, DispatchOutcome, DispatchRequest, DispatchStatus } from "@foreman/core";
import { DispatcherBusyError } from "../src/dispatch/herdr.ts";
import { runLoop, type Candidate, type Loop, type LoopContext, type Rule } from "../src/engine.ts";
import { InflightStore } from "../src/inflight.ts";

const ALWAYS_APPROVE = { confirm: async () => true, close: () => {} };

/**
 * Records every dispatch and lets a test resolve each `settle()` on demand,
 * so a run's progress is driven by awaiting the fake's own signals rather
 * than a wall-clock sleep. `dispatched` also exposes a promise per count so
 * a test can await "N dispatches have happened" deterministically.
 */
class FakeDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  dispatched: DispatchRequest[] = [];
  #resolvers = new Map<string, (outcome: DispatchOutcome) => void>();
  #countWaiters: { count: number; resolve: () => void }[] = [];

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    this.dispatched.push(request);
    for (const waiter of [...this.#countWaiters]) {
      if (this.dispatched.length >= waiter.count) {
        waiter.resolve();
        this.#countWaiters = this.#countWaiters.filter((w) => w !== waiter);
      }
    }
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: null,
    }));
  }

  async status(): Promise<DispatchStatus> {
    return "running";
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    const { promise, resolve } = Promise.withResolvers<DispatchOutcome>();
    this.#resolvers.set(handle.dispatchId, resolve);
    return promise;
  }

  /** Awaits until at least `count` dispatches have been recorded. */
  async untilDispatched(count: number): Promise<void> {
    if (this.dispatched.length >= count) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#countWaiters.push({ count, resolve });
    await promise;
  }

  finishSettle(dispatchId: string, exitCode: number): void {
    const resolve = this.#resolvers.get(dispatchId);
    if (!resolve) throw new Error(`no pending settle for ${dispatchId}`);
    this.#resolvers.delete(dispatchId);
    resolve({
      handle: { dispatchId, agent: "foreman-implement", issueId: null, startedAt: "", pid: null, herdr: null },
      status: "settled",
      exitCode,
      log: "",
    });
  }

  async available(): Promise<boolean> {
    return true;
  }
}

interface Snapshot {
  candidates: Candidate[];
}

function makeCandidate(key: string): Candidate {
  return {
    key,
    agent: "foreman-implement",
    command: "/foreman:implement",
    subject: key,
    cwd: "/repo",
    worktree: null,
    reason: `dispatch ${key}`,
  };
}

function makeLoop(candidates: Candidate[], concurrency: number): Loop<Snapshot> {
  const rule: Rule<Snapshot> = { name: "test", select: (snapshot) => snapshot.candidates };
  return {
    name: "build",
    concurrency,
    async fetch() {
      return { candidates };
    },
    rules: [rule],
  };
}

const tempDirs: string[] = [];
function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-engine-test-"));
  tempDirs.push(dir);
  return join(dir, "state.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeCtx(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    linear: { issue: async () => null } as unknown as LoopContext["linear"],
    github: {} as LoopContext["github"],
    entry: {
      alias: "test",
      repoPath: "/repo",
      branchPattern: "<issue-id>",
      worktreePattern: "../<repo>",
      baseBranch: "main",
    } as unknown as LoopContext["entry"],
    config: { loop: { retryCap: 2 } } as unknown as LoopContext["config"],
    now: () => new Date(),
    ...overrides,
  };
}

describe("runLoop", () => {
  it("dispatches a candidate exactly once while it stays in flight across repeated polls", async () => {
    const dispatcher = new FakeDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    const loop = makeLoop([makeCandidate("issue:A")], 3);

    const run = runLoop(loop, makeCtx(), {
      once: false,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: () => {},
      pollMs: 5,
    });

    await dispatcher.untilDispatched(1);
    // A second and third poll tick (5ms apart) must not add a second dispatch for the same still-in-flight key.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dispatcher.dispatched.length).toBe(1);

    const dispatchId = dispatcher.dispatched[0]!.items[0]!.dispatchId;
    // Signal stop first: `runLoop` checks `stop` right after the wake race
    // resolves, before fetching again, so finishing the settle afterward
    // wakes a loop that is about to exit rather than one that re-offers
    // the now-idle candidate a second time.
    process.emit("SIGINT" as never);
    dispatcher.finishSettle(dispatchId, 0);
    await run;
    expect(dispatcher.dispatched.length).toBe(1);
    expect(state.has("issue:A")).toBe(false);
  });

  it("respects the concurrency cap: a candidate beyond the cap is not dispatched in one pass", async () => {
    const dispatcher = new FakeDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    const loop = makeLoop(
      [makeCandidate("issue:A"), makeCandidate("issue:B"), makeCandidate("issue:C"), makeCandidate("issue:D")],
      3,
    );

    const run = runLoop(loop, makeCtx(), {
      once: true,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: () => {},
      pollMs: 5000,
    });

    await dispatcher.untilDispatched(3);
    expect(dispatcher.dispatched.length).toBe(3);
    for (const request of dispatcher.dispatched) {
      dispatcher.finishSettle(request.items[0]!.dispatchId, 0);
    }
    await run;
    expect(dispatcher.dispatched.length).toBe(3);
  });

  it("logs once and does not re-dispatch a non-issue candidate whose key has exhausted the retry cap", async () => {
    const dispatcher = new FakeDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    state.recordFailure("project:xyz");
    state.recordFailure("project:xyz");
    const loop = makeLoop([makeCandidate("project:xyz")], 3);
    const logs: string[] = [];

    await runLoop(loop, makeCtx(), {
      once: true,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: (message) => logs.push(message),
      pollMs: 5000,
    });

    expect(dispatcher.dispatched.length).toBe(0);
    expect(logs.some((line) => line.includes("gave up after 2 failed dispatches"))).toBe(true);
  });

  it("escalates an issue-keyed candidate that has exhausted the retry cap: moves to Blocked and posts a block marker, exactly once", async () => {
    const dispatcher = new FakeDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    state.recordFailure("issue:ENG-1");
    state.recordFailure("issue:ENG-1");
    const loop = makeLoop([makeCandidate("issue:ENG-1")], 3);
    const updateCalls: unknown[] = [];
    const commentCalls: unknown[] = [];
    let blocked = false;
    const fakeLinear = {
      issue: async () =>
        blocked
          ? null // second poll: already-escalated issues drop out of the notHandsOff() snapshot, so nothing re-fires
          : {
              id: "id-1",
              identifier: "ENG-1",
              team: { id: "team-1" },
              state: { id: "state-in-progress", name: "In Progress", type: "started", position: 3 },
              labels: [],
            },
      workflowStates: async () => [{ id: "state-blocked", name: "Blocked", type: "started", position: 4 }],
      ensureLabel: async (name: string) => ({ id: `label-${name}`, name }),
      updateIssue: async (id: string, input: unknown) => {
        updateCalls.push({ id, input });
        blocked = true;
      },
      createComment: async (input: unknown) => {
        commentCalls.push(input);
      },
    } as unknown as LoopContext["linear"];

    await runLoop(loop, makeCtx({ linear: fakeLinear }), {
      once: true,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: () => {},
      pollMs: 5000,
    });

    expect(dispatcher.dispatched.length).toBe(0);
    expect(updateCalls.length).toBe(1);
    expect(commentCalls.length).toBe(1);
  });

  it("does not record a failure for a DispatcherBusyError, only logs a routine skip", async () => {
    class BusyDispatcher extends FakeDispatcher {
      override async dispatch(): Promise<never> {
        throw new DispatcherBusyError("worktree pane still hosts a working agent");
      }
    }
    const dispatcher = new BusyDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    const loop = makeLoop([makeCandidate("issue:A")], 3);
    const logs: string[] = [];

    await runLoop(loop, makeCtx(), {
      once: true,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: (message) => logs.push(message),
      pollMs: 5000,
    });

    expect(state.failures("issue:A")).toBe(0);
    expect(logs.some((line) => line.includes("skipped, its workspace is busy"))).toBe(true);
  });

  it("settling an in-flight dispatch removes it from the in-flight set and wakes the next poll without waiting the full pollMs", async () => {
    const dispatcher = new FakeDispatcher();
    const state = await InflightStore.load(tempStatePath(), dispatcher);
    const loop = makeLoop([makeCandidate("issue:A")], 1);

    const run = runLoop(loop, makeCtx(), {
      once: false,
      dispatcher,
      confirmer: ALWAYS_APPROVE,
      state,
      log: () => {},
      pollMs: 60_000,
    });

    await dispatcher.untilDispatched(1);
    expect(state.has("issue:A")).toBe(true);
    dispatcher.finishSettle(dispatcher.dispatched[0]!.items[0]!.dispatchId, 1);

    // With pollMs at 60s, the loop only reaches a second fetch this fast if
    // settle() woke it — the failed dispatch then re-offers issue:A, so a
    // second dispatch appearing well under 60s proves the wake path, not the
    // poll timer.
    await dispatcher.untilDispatched(2);
    expect(state.failures("issue:A")).toBe(1);

    process.emit("SIGINT" as never);
    dispatcher.finishSettle(dispatcher.dispatched[1]!.items[0]!.dispatchId, 0);
    await run;
  });
});
