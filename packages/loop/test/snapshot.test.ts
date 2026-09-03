import { describe, expect, it } from "bun:test";
import { emptyBookkeepingState } from "../src/bookkeeping.ts";
import { buildSnapshot, toBlockedItem, toProposalItem, toQueueItem } from "../src/snapshot.ts";
import type { GlobalConfig } from "@foreman/core";

function makeConfig(): GlobalConfig {
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
      mode: "yolo",
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

const NOW = new Date("2026-06-01T12:00:00.000Z");

describe("buildSnapshot", () => {
  it("produces the documented shape from minimal fixture input", () => {
    const snapshot = buildSnapshot({
      loopId: "repo:product",
      kind: "repo",
      label: "product",
      alias: "product",
      team: "ENG",
      repoPath: "/repos/product",
      initiativeIds: ["initiative-1"],
      pid: 1234,
      startedAt: "2026-06-01T11:00:00.000Z",
      version: "0.1.0",
      config: makeConfig(),
      runState: "running",
      dispatcherKind: "herdr",
      pausedAt: null,
      lastTickAt: "2026-06-01T11:55:00.000Z",
      ticks: 4,
      now: NOW,
      workers: [
        { name: "refine", cadenceMs: 300_000, lastRunAt: "2026-06-01T11:56:00.000Z", running: false, lastReport: null },
        { name: "implement", cadenceMs: 300_000, lastRunAt: null, running: false, lastReport: null },
      ],
      bookkeeping: emptyBookkeepingState(),
      agentStatuses: new Map(),
      boardCounts: { blocked: 1 },
      linear: { ok: true, lastPollAt: null, lastError: null, requests: 3 },
      dispatchHistory: [0, 1, 2],
    });

    expect(snapshot.loop).toEqual({
      id: "repo:product",
      kind: "repo",
      label: "product",
      alias: "product",
      team: "ENG",
      repoPath: "/repos/product",
      initiativeIds: ["initiative-1"],
      pid: 1234,
      startedAt: "2026-06-01T11:00:00.000Z",
      version: "0.1.0",
    });
    expect(snapshot.runtime.state).toBe("running");
    expect(snapshot.runtime.mode).toBe("yolo");
    expect(snapshot.runtime.ticks).toBe(4);
    expect(snapshot.runtime.uptimeMs).toBe(NOW.getTime() - new Date("2026-06-01T11:00:00.000Z").getTime());

    // `nextTickAt` is the earliest `lastRunAt + cadenceMs` among workers that have run at least once.
    expect(snapshot.runtime.nextTickAt).toBe(
      new Date(new Date("2026-06-01T11:56:00.000Z").getTime() + 300_000).toISOString(),
    );
    const refine = snapshot.workers.find((worker) => worker.name === "refine");
    const implement = snapshot.workers.find((worker) => worker.name === "implement");
    expect(refine?.nextRunAt).toBe(new Date(new Date("2026-06-01T11:56:00.000Z").getTime() + 300_000).toISOString());
    expect(implement?.nextRunAt).toBeNull();

    expect(snapshot.wip).toEqual({
      global: { used: 0, cap: 3 },
      byStage: [
        { stage: "refine", used: 0, cap: 2 },
        { stage: "implement", used: 0, cap: 3 },
        { stage: "review", used: 0, cap: 2 },
        { stage: "plan", used: 0, cap: 1 },
      ],
    });

    expect(snapshot.board.blocked).toBe(1);
    expect(snapshot.board.backlog).toBe(0);
    expect(snapshot.history.dispatchesPerTick).toEqual([0, 1, 2]);
    expect(snapshot.linear.requests).toBe(3);
    expect(snapshot.queues.decisions).toEqual([]);
  });

  it("computes pastTtl for an in-flight agent older than the config's lock TTL", () => {
    const config = makeConfig();
    const bookkeeping = emptyBookkeepingState();
    bookkeeping.inFlight.push({
      agent: "foreman-implement",
      issueId: "ENG-1",
      dispatchId: "d1",
      startedAt: new Date(NOW.getTime() - 20_000_000).toISOString(),
      stage: "implement",
    });

    const snapshot = buildSnapshot({
      loopId: "repo:product",
      kind: "repo",
      label: "product",
      alias: "product",
      team: "ENG",
      repoPath: "/repos/product",
      initiativeIds: [],
      pid: 1,
      startedAt: NOW.toISOString(),
      version: "0.1.0",
      config,
      runState: "running",
      dispatcherKind: "print",
      pausedAt: null,
      lastTickAt: null,
      ticks: 0,
      now: NOW,
      workers: [],
      bookkeeping,
      agentStatuses: new Map([["d1", { status: "running" as const, handle: null }]]),
      boardCounts: {},
      linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
      dispatchHistory: [],
    });

    const ttlMs = 2 * config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs;
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.ttlMs).toBe(ttlMs);
    expect(snapshot.agents[0]?.pastTtl).toBe(20_000_000 > ttlMs);
    expect(snapshot.agents[0]?.status).toBe("running");
    expect(snapshot.agents[0]?.worktree).toBe("/repos/product-ENG-1");
  });

  it("uses the repo entry's own worktreePattern override over repoDefaults", () => {
    const config = makeConfig();
    config.repos.product = {
      path: "/repos/product",
      team: "ENG",
      initiatives: ["initiative-1"],
      worktreePattern: "../custom-<ISSUE-ID>",
    };
    const bookkeeping = emptyBookkeepingState();
    bookkeeping.inFlight.push({
      agent: "foreman-implement",
      issueId: "ENG-1",
      dispatchId: "d1",
      startedAt: NOW.toISOString(),
      stage: "implement",
    });

    const snapshot = buildSnapshot({
      loopId: "repo:product",
      kind: "repo",
      label: "product",
      alias: "product",
      team: "ENG",
      repoPath: "/repos/product",
      initiativeIds: [],
      pid: 1,
      startedAt: NOW.toISOString(),
      version: "0.1.0",
      config,
      runState: "running",
      dispatcherKind: "print",
      pausedAt: null,
      lastTickAt: null,
      ticks: 0,
      now: NOW,
      workers: [],
      bookkeeping,
      agentStatuses: new Map(),
      boardCounts: {},
      linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
      dispatchHistory: [],
    });

    expect(snapshot.agents[0]?.worktree).toBe("/repos/custom-ENG-1");
  });

  it("trips backpressure once the merged blocked count exceeds the configured threshold", () => {
    const config = makeConfig();
    const belowThreshold = buildSnapshot({
      loopId: "repo:product",
      kind: "repo",
      label: "product",
      alias: "product",
      team: null,
      repoPath: null,
      initiativeIds: [],
      pid: 1,
      startedAt: NOW.toISOString(),
      version: "0.1.0",
      config,
      runState: "running",
      dispatcherKind: "none",
      pausedAt: null,
      lastTickAt: null,
      ticks: 0,
      now: NOW,
      workers: [],
      bookkeeping: emptyBookkeepingState(),
      agentStatuses: new Map(),
      boardCounts: { blocked: config.loop.backpressureThreshold },
      linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
      dispatchHistory: [],
    });
    expect(belowThreshold.backpressure.tripped).toBe(false);
    expect(belowThreshold.backpressure.reason).toBeNull();

    const tripped = buildSnapshot({
      ...{
        loopId: "repo:product",
        kind: "repo" as const,
        label: "product",
        alias: "product",
        team: null,
        repoPath: null,
        initiativeIds: [],
        pid: 1,
        startedAt: NOW.toISOString(),
        version: "0.1.0",
        config,
        runState: "running" as const,
        dispatcherKind: "none" as const,
        pausedAt: null,
        lastTickAt: null,
        ticks: 0,
        now: NOW,
        workers: [],
        bookkeeping: emptyBookkeepingState(),
        agentStatuses: new Map(),
        linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
        dispatchHistory: [],
      },
      boardCounts: { blocked: config.loop.backpressureThreshold + 1 },
    });
    expect(tripped.backpressure.tripped).toBe(true);
    expect(tripped.backpressure.reason).toBe("Blocked-human queue exceeds the backpressure threshold.");
  });
});

describe("toQueueItem / toBlockedItem / toProposalItem", () => {
  function makeIssue(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "id-1",
      identifier: "ENG-1",
      title: "Fix the thing",
      description: null,
      priority: 2,
      estimate: 3,
      url: "https://linear.app/eng-1",
      branchName: "eng-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      state: { id: "s1", name: "Todo", type: "unstarted", position: 0 },
      labels: [{ id: "l1", name: "blocked:needs-input", parentId: null }],
      team: { id: "t1", key: "ENG", name: "Engineering" },
      project: null,
      parent: null,
      children: [],
      assignee: { id: "u1", name: "ada", displayName: "Ada" },
      relations: [],
      comments: [],
      ...overrides,
    };
  }

  it("maps an issue to a QueueItem", () => {
    const item = toQueueItem(makeIssue() as never);
    expect(item).toEqual({
      issueId: "ENG-1",
      title: "Fix the thing",
      state: "Todo",
      priority: 2,
      estimate: 3,
      labels: ["blocked:needs-input"],
      assignee: "Ada",
      updatedAt: "2026-01-02T00:00:00.000Z",
      url: "https://linear.app/eng-1",
    });
  });

  it("maps a blocked issue without a BlockRecord to the documented fallback question", () => {
    const item = toBlockedItem(makeIssue() as never);
    expect(item.type).toBe("blocked:needs-input");
    expect(item.question).toBe("(no BlockRecord found on this issue)");
    expect(item.options).toEqual([]);
    expect(item.recommendation).toBeNull();
  });

  it("maps a proposal issue with no proposal marker to a safe default", () => {
    const item = toProposalItem(makeIssue() as never);
    expect(item.destination).toBe("unknown");
    expect(item.duplicateOf).toBeNull();
    expect(item.proposedPriority).toBeNull();
  });
});
