import { describe, expect, it } from "bun:test";
import type { GlobalConfig, Issue, ProjectRef } from "@foreman/core";
import { AGENT_LABEL, BLOCKED_LABEL, DISPATCH_COMMAND, LEGACY_LABEL, TYPE_LABEL } from "@foreman/core";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { confirmationRequired, effectiveMode, nextActions } from "../src/routing.ts";
import type { BoardSnapshot, PlanCandidate, ReviewCandidate } from "../src/routing.ts";

// ---- fixtures --------------------------------------------------------------

function makeConfig(overrides: Partial<GlobalConfig["loop"]> = {}): GlobalConfig {
  const defaultLoop: GlobalConfig["loop"] = {
    wipGlobal: 3,
    wip: { refine: 2, implement: 3, review: 2, plan: 1 },
    readyBufferTarget: 5,
    backpressureThreshold: 5,
    retryCap: 2,
    reviewCycleCap: 2,
    cadenceMinutes: 5,
    mode: "yolo",
    workerModes: {},
    mergeDetection: true,
    cleanupMergedWorktrees: true,
    stateDir: "~/.foreman/state",
  };
  return {
    repos: {},
    loop: { ...defaultLoop, ...overrides },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
    linear: {
      apiKeyEnv: "LINEAR_API_KEY",
      apiKeyFile: null,
      endpoint: "https://api.linear.app/graphql",
    },
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
      orchestratorMaxBatches: 20,
    },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

let issueSeq = 0;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  issueSeq += 1;
  const id = overrides.identifier ?? `ENG-${issueSeq}`;
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
    description: "## Acceptance Criteria\n- [ ] does the thing\n",
    priority: 3,
    estimate: 2,
    url: `https://linear.app/issue/${id}`,
    branchName: id.toLowerCase(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: { id: "state-1", name: "Backlog", type: "backlog", position: 1 },
    labels: [label(TYPE_LABEL.feature)],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "proj-1", name: "Project" },
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

function label(name: string): { id: string; name: string; parentId: string | null } {
  return { id: `label-${name}`, name, parentId: null };
}

function emptySnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    backlog: [],
    todo: [],
    reviewCandidates: [],
    blockedHumanCount: 0,
    readyBufferCount: 0,
    planCandidates: [],
    ...overrides,
  };
}

function freshBookkeeping(): Bookkeeping {
  return Bookkeeping.load("/nonexistent/foreman-routing-test/bookkeeping.json");
}

function makeTodoIssue(overrides: Partial<Issue> = {}): Issue {
  return makeIssue({
    state: { id: "state-todo", name: "Todo", type: "unstarted", position: 2 },
    labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)],
    ...overrides,
  });
}

function makeReviewCandidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    issue: makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } }),
    prOpen: true,
    headSha: "abc123",
    hasReviewForHead: false,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectRef> = {}): ProjectRef {
  return { id: "project-1", name: "Search revamp", ...overrides };
}

function makePlanCandidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return { project: makeProject(), ...overrides };
}

const NOW = new Date("2026-06-01T12:00:00.000Z");

// ---- per-stage candidate selection -----------------------------------------

describe("nextActions — per-stage selection", () => {
  it("refine selects backlog candidates, including legacy issues the caller has merged in from Todo", () => {
    const config = makeConfig();
    // `refine.ts` merges `legacy` Todo issues into `backlog` before calling
    // `nextActions` (SPEC §4.9) — routing itself only ever reads `backlog`.
    const legacyTodo = makeIssue({ labels: [label(TYPE_LABEL.feature), label(LEGACY_LABEL)], priority: 2 });
    const plainBacklog = makeIssue({ priority: 2 });
    const plainTodo = makeTodoIssue({ priority: 2 });
    const snapshot = emptySnapshot({
      backlog: [plainBacklog, legacyTodo],
      todo: [plainTodo],
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    const refineIssueIds = decisions.filter((d) => d.agent === "foreman-refine").map((d) => d.issueId);
    expect(refineIssueIds.sort()).toEqual([legacyTodo.identifier, plainBacklog.identifier].sort());
    // The plain Todo issue is an implement candidate, never a refine one.
    expect(decisions.some((d) => d.agent === "foreman-implement" && d.issueId === plainTodo.identifier)).toBe(true);
  });

  it("implement selects only from todo issues passing the implementation gate", () => {
    const config = makeConfig();
    const readyIssue = makeTodoIssue();
    const snapshot = emptySnapshot({ todo: [readyIssue] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ agent: "foreman-implement", issueId: readyIssue.identifier });
  });

  it("review selects only from review candidates with an open PR and no ReviewResult for head", () => {
    const config = makeConfig();
    const candidate = makeReviewCandidate();
    const snapshot = emptySnapshot({ reviewCandidates: [candidate] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ agent: "foreman-review", issueId: candidate.issue.identifier });
  });
});

// ---- suppressing labels -----------------------------------------------------

describe("nextActions — suppressing labels block dispatch for every worker", () => {
  it("refine: agent:proposed suppresses the candidate", () => {
    const config = makeConfig();
    const issue = makeIssue({ priority: 2, labels: [label(AGENT_LABEL.proposed)] });
    const snapshot = emptySnapshot({ backlog: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: issue.identifier, code: "suppressed-proposed" }),
    );
  });

  it("implement: agent:running suppresses the candidate", () => {
    const config = makeConfig();
    const issue = makeTodoIssue({ labels: [label(AGENT_LABEL.ready), label(AGENT_LABEL.running)] });
    const snapshot = emptySnapshot({ todo: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: issue.identifier, code: "suppressed-running" }),
    );
  });

  it("review: agent:hands-off suppresses the candidate", () => {
    const config = makeConfig();
    const candidate = makeReviewCandidate({
      issue: makeIssue({ labels: [label(AGENT_LABEL.handsOff)] }),
    });
    const snapshot = emptySnapshot({ reviewCandidates: [candidate] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: candidate.issue.identifier, code: "suppressed-hands-off" }),
    );
  });

  it("blocked:* suppresses a refine candidate", () => {
    const config = makeConfig();
    const issue = makeIssue({ priority: 2, labels: [label(BLOCKED_LABEL.needsDecision)] });
    const snapshot = emptySnapshot({ backlog: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: issue.identifier, code: "suppressed-blocked" }),
    );
  });
});

// ---- backpressure ------------------------------------------------------------

describe("nextActions — global backpressure", () => {
  it("stops all three workers once the blocked-human count exceeds the threshold", () => {
    const config = makeConfig({ backpressureThreshold: 5 });
    const snapshot = emptySnapshot({
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
      blockedHumanCount: 6,
    });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    const codes = new Set(skipped.map((s) => s.code));
    expect(codes.has("backpressure-blocked-queue")).toBe(true);
    for (const stage of ["refine", "implement", "review"] as const) {
      expect(skipped.some((s) => s.stage === stage && s.code === "backpressure-blocked-queue")).toBe(true);
    }
  });

  it("threshold 0 stops every worker when exactly one issue is blocked", () => {
    const config = makeConfig({ backpressureThreshold: 0 });
    const snapshot = emptySnapshot({
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
      blockedHumanCount: 1,
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
  });
});

// ---- WIP ----------------------------------------------------------------------

describe("nextActions — WIP", () => {
  it("wipGlobal reached by implement alone starves refine (SPEC §17.6: correct)", () => {
    const config = makeConfig({ wipGlobal: 3, wip: { refine: 2, implement: 3, review: 2, plan: 1 } });
    const bookkeeping = freshBookkeeping();
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-900", dispatchId: "d1", startedAt: NOW.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-901", dispatchId: "d2", startedAt: NOW.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-902", dispatchId: "d3", startedAt: NOW.toISOString(), stage: "implement" });

    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })] });
    const { decisions, skipped } = nextActions(snapshot, config, bookkeeping);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "wip-global-full" }));
  });

  it("per-stage sub-limit caps a stage independently of the global cap", () => {
    const config = makeConfig({ wipGlobal: 10, wip: { refine: 1, implement: 3, review: 2, plan: 1 } });
    const bookkeeping = freshBookkeeping();
    bookkeeping.recordDispatch({ agent: "foreman-refine", issueId: "ENG-800", dispatchId: "d1", startedAt: NOW.toISOString(), stage: "refine" });

    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })] });
    const { decisions, skipped } = nextActions(snapshot, config, bookkeeping);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "wip-stage-full" }));
  });
});

// ---- readyBufferTarget --------------------------------------------------------

describe("nextActions — refine buffer depth", () => {
  it("idles once the Ready buffer is at target", () => {
    const config = makeConfig({ readyBufferTarget: 5 });
    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })], readyBufferCount: 5 });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "buffer-satisfied" }));
  });

  it("dispatches when below target", () => {
    const config = makeConfig({ readyBufferTarget: 5 });
    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })], readyBufferCount: 2 });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions.some((d) => d.agent === "foreman-refine")).toBe(true);
  });

  it("names the /foreman:refine command and the issue as its subject, leaving the dispatcher to join them", () => {
    const config = makeConfig({ readyBufferTarget: 5 });
    const issue = makeIssue({ identifier: "ENG-1", priority: 2 });
    const snapshot = emptySnapshot({ backlog: [issue], readyBufferCount: 2 });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    const decision = decisions.find((d) => d.agent === "foreman-refine");
    expect(decision?.command).toBe(DISPATCH_COMMAND.refine);
    expect(decision?.subject).toBe("ENG-1");
  });
});

// ---- mode: routing is autonomy-blind -------------------------------------------

describe("effectiveMode", () => {
  it("falls back to loop.mode when no worker override is set", () => {
    const loop = makeConfig({ mode: "confirm" }).loop;
    expect(effectiveMode("implement", loop)).toBe("confirm");
  });

  it("uses a worker override before the global fallback", () => {
    const loop = makeConfig({ mode: "confirm", workerModes: { implement: "yolo" } }).loop;
    expect(effectiveMode("implement", loop)).toBe("yolo");
    expect(effectiveMode("review", loop)).toBe("confirm");
  });
});

describe("confirmationRequired", () => {
  it("is true when loop.mode is confirm", () => {
    const loop = makeConfig({ mode: "confirm" }).loop;
    expect(confirmationRequired(loop)).toBe(true);
  });

  it("is true when loop.mode is yolo but a worker override is confirm", () => {
    const loop = makeConfig({ mode: "yolo", workerModes: { implement: "confirm" } }).loop;
    expect(confirmationRequired(loop)).toBe(true);
  });

  it("is false when loop.mode is yolo with no overrides", () => {
    const loop = makeConfig({ mode: "yolo" }).loop;
    expect(confirmationRequired(loop)).toBe(false);
  });
});

describe("nextActions — produces dispatch intents regardless of mode", () => {
  it("dispatches under confirm mode exactly as it would under yolo — mode gating is WorkerContext.confirm's job, not routing's", () => {
    const snapshot = emptySnapshot({
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
    });
    const confirmConfig = makeConfig({ mode: "confirm", wipGlobal: 10 });
    const yoloConfig = makeConfig({ mode: "yolo", wipGlobal: 10 });
    const confirmAgents = new Set(nextActions(snapshot, confirmConfig, freshBookkeeping()).decisions.map((d) => d.agent));
    const yoloAgents = new Set(nextActions(snapshot, yoloConfig, freshBookkeeping()).decisions.map((d) => d.agent));
    expect(confirmAgents.size).toBe(3);
    expect(yoloAgents).toEqual(confirmAgents);
  });
});

// ---- ordering -----------------------------------------------------------------

describe("nextActions — ordering by priority then age", () => {
  it("higher priority (lower rank value) goes first within a stage", () => {
    const config = makeConfig({ wip: { refine: 1, implement: 3, review: 2, plan: 1 }, wipGlobal: 10 });
    const low = makeIssue({ identifier: "ENG-10", priority: 4, createdAt: "2026-01-01T00:00:00.000Z" });
    const urgent = makeIssue({ identifier: "ENG-11", priority: 1, createdAt: "2026-01-02T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [low, urgent] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    // wip.refine is 1, so only the highest-priority candidate is dispatched.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-11");
  });

  it("older issues go first at equal priority", () => {
    const config = makeConfig({ wip: { refine: 1, implement: 3, review: 2, plan: 1 }, wipGlobal: 10 });
    const newer = makeIssue({ identifier: "ENG-20", priority: 2, createdAt: "2026-03-01T00:00:00.000Z" });
    const older = makeIssue({ identifier: "ENG-21", priority: 2, createdAt: "2026-01-01T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [newer, older] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-21");
  });

  it("unprioritized (None) issues never get picked ahead of a prioritized one", () => {
    const config = makeConfig({ wip: { refine: 1, implement: 3, review: 2, plan: 1 }, wipGlobal: 10 });
    const none = makeIssue({ identifier: "ENG-30", priority: 0, createdAt: "2026-01-01T00:00:00.000Z" });
    const low = makeIssue({ identifier: "ENG-31", priority: 4, createdAt: "2026-06-01T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [none, low] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-31");
  });
});

// ---- non-goal: no merge -------------------------------------------------------

describe("nextActions — never produces a merge decision", () => {
  it("no decision's agent or command ever names merge", () => {
    const config = makeConfig();
    const snapshot = emptySnapshot({
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    for (const decision of decisions) {
      expect(decision.command.toLowerCase()).not.toContain("merge");
      expect(String(decision.agent).toLowerCase()).not.toContain("merge");
    }
  });
});

// ---- plan: bare-project decomposition ------------------------------------------

describe("nextActions — plan", () => {
  it("dispatches foreman-plan at a bare (zero-issue) project", () => {
    const config = makeConfig();
    const candidate = makePlanCandidate();
    const snapshot = emptySnapshot({ planCandidates: [candidate] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      agent: "foreman-plan",
      issueId: null,
      projectId: candidate.project.id,
      command: DISPATCH_COMMAND.plan,
      subject: candidate.project.id,
    });
  });

  it("skips a project that already has a plan dispatch in flight", () => {
    const config = makeConfig();
    const candidate = makePlanCandidate();
    const bookkeeping = freshBookkeeping();
    bookkeeping.recordDispatch({
      agent: "foreman-plan",
      issueId: null,
      projectId: candidate.project.id,
      dispatchId: "d1",
      startedAt: NOW.toISOString(),
      stage: "plan",
    });
    const snapshot = emptySnapshot({ planCandidates: [candidate] });
    const { decisions, skipped } = nextActions(snapshot, config, bookkeeping);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ stage: "plan", projectId: candidate.project.id, code: "already-in-flight" }),
    );
  });

  it("backpressure stops plan alongside the other three stages", () => {
    const config = makeConfig({ backpressureThreshold: 5 });
    const candidate = makePlanCandidate();
    const snapshot = emptySnapshot({ planCandidates: [candidate], blockedHumanCount: 6 });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ stage: "plan", code: "backpressure-blocked-queue" }),
    );
  });

  it("plan WIP cap of 1 (default) admits only one of two bare projects in the same pass", () => {
    const config = makeConfig();
    const first = makePlanCandidate({ project: makeProject({ id: "project-1" }) });
    const second = makePlanCandidate({ project: makeProject({ id: "project-2" }) });
    const snapshot = emptySnapshot({ planCandidates: [first, second] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
    expect(skipped).toContainEqual(
      expect.objectContaining({ stage: "plan", projectId: second.project.id, code: "wip-stage-full" }),
    );
  });

  it("the Maintenance project never appears as a candidate (worker-level, not routing — documented here for discoverability)", () => {
    // routePlan itself has no Maintenance special-case: exclusion happens in
    // workers/plan.ts's candidate discovery, before a snapshot ever reaches
    // nextActions. A project named "Maintenance" passed in here would still
    // be dispatched — this test documents that boundary rather than
    // asserting routing behavior that doesn't exist.
    const config = makeConfig();
    const maintenance = makePlanCandidate({ project: makeProject({ name: "Maintenance" }) });
    const snapshot = emptySnapshot({ planCandidates: [maintenance] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping());
    expect(decisions).toHaveLength(1);
  });
});
