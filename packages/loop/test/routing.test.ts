import { describe, expect, it } from "bun:test";
import type { GlobalConfig, Issue } from "@foreman/core";
import { AGENT_LABEL, BLOCKED_LABEL, LEGACY_LABEL, TYPE_LABEL } from "@foreman/core";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { nextActions } from "../src/routing.ts";
import type { BoardSnapshot, ReviewCandidate } from "../src/routing.ts";

// ---- fixtures --------------------------------------------------------------

function makeConfig(overrides: Partial<GlobalConfig["loop"]> = {}): GlobalConfig {
  const defaultLoop: GlobalConfig["loop"] = {
    wipGlobal: 3,
    wip: { triage: 1, refine: 2, implement: 3, review: 2 },
    readyBufferTarget: 5,
    backpressureThreshold: 5,
    retryCap: 2,
    reviewCycleCap: 2,
    cadenceMinutes: 5,
    triageWindow: "06:00",
    stage: "full",
    dispatcher: "print",
    mergeDetection: true,
    stateDir: "~/.foreman/state",
  };
  return {
    projects: {},
    loop: { ...defaultLoop, ...overrides },
    triage: { staleLowDays: 90, batchSize: 20 },
    linear: {
      apiKeyEnv: "LINEAR_API_KEY",
      apiKeyFile: null,
      teamKeys: [],
      endpoint: "https://api.linear.app/graphql",
    },
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
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
    inbox: [],
    backlog: [],
    todo: [],
    reviewCandidates: [],
    blockedHumanCount: 0,
    proposedCount: 0,
    readyBufferCount: 0,
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

const NOW = new Date("2026-06-01T12:00:00.000Z");

// ---- per-stage candidate selection -----------------------------------------

describe("nextActions — per-stage selection", () => {
  it("triage selects only from the inbox and dispatches nothing else", () => {
    const config = makeConfig();
    const snapshot = emptySnapshot({ inbox: [makeIssue()] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.agent).toBe("foreman-triage");
    expect(decisions[0]?.issueId).toBeNull();
  });

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
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    const refineIssueIds = decisions.filter((d) => d.agent === "foreman-refine").map((d) => d.issueId);
    expect(refineIssueIds.sort()).toEqual([legacyTodo.identifier, plainBacklog.identifier].sort());
    // The plain Todo issue is an implement candidate, never a refine one.
    expect(decisions.some((d) => d.agent === "foreman-implement" && d.issueId === plainTodo.identifier)).toBe(true);
  });

  it("implement selects only from todo issues passing the implementation gate", () => {
    const config = makeConfig();
    const readyIssue = makeTodoIssue();
    const snapshot = emptySnapshot({ todo: [readyIssue] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ agent: "foreman-implement", issueId: readyIssue.identifier });
  });

  it("review selects only from review candidates with an open PR and no ReviewResult for head", () => {
    const config = makeConfig();
    const candidate = makeReviewCandidate();
    const snapshot = emptySnapshot({ reviewCandidates: [candidate] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ agent: "foreman-review", issueId: candidate.issue.identifier });
  });
});

// ---- suppressing labels -----------------------------------------------------

describe("nextActions — suppressing labels block dispatch for every worker", () => {
  it("triage: blocked:* on an inbox issue does not block the batch dispatch itself, but per-issue labels are irrelevant to the batch", () => {
    // Triage dispatches as a batch, not per-issue, so label suppression is
    // exercised through the other three workers below; this test documents
    // that the inbox count alone drives triage.
    const config = makeConfig();
    const snapshot = emptySnapshot({ inbox: [makeIssue({ labels: [label(BLOCKED_LABEL.needsInput)] })] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    expect(decisions).toHaveLength(1);
  });

  it("refine: agent:proposed suppresses the candidate", () => {
    const config = makeConfig();
    const issue = makeIssue({ priority: 2, labels: [label(AGENT_LABEL.proposed)] });
    const snapshot = emptySnapshot({ backlog: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: issue.identifier, code: "suppressed-proposed" }),
    );
  });

  it("implement: agent:running suppresses the candidate", () => {
    const config = makeConfig();
    const issue = makeTodoIssue({ labels: [label(AGENT_LABEL.ready), label(AGENT_LABEL.running)] });
    const snapshot = emptySnapshot({ todo: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), NOW);
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
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: candidate.issue.identifier, code: "suppressed-hands-off" }),
    );
  });

  it("blocked:* suppresses a refine candidate", () => {
    const config = makeConfig();
    const issue = makeIssue({ priority: 2, labels: [label(BLOCKED_LABEL.needsDecision)] });
    const snapshot = emptySnapshot({ backlog: [issue] });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(
      expect.objectContaining({ issueId: issue.identifier, code: "suppressed-blocked" }),
    );
  });
});

// ---- backpressure ------------------------------------------------------------

describe("nextActions — global backpressure", () => {
  it("stops all four workers once the blocked-human count exceeds the threshold", () => {
    const config = makeConfig({ backpressureThreshold: 5 });
    const snapshot = emptySnapshot({
      inbox: [makeIssue()],
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
      blockedHumanCount: 6,
    });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    expect(decisions).toHaveLength(0);
    const codes = new Set(skipped.map((s) => s.code));
    expect(codes.has("backpressure-blocked-queue")).toBe(true);
    for (const stage of ["triage", "refine", "implement", "review"] as const) {
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
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(0);
  });

  it("an agent:proposed count above the threshold suppresses only the triage dispatch", () => {
    const config = makeConfig({ backpressureThreshold: 5 });
    const snapshot = emptySnapshot({
      inbox: [makeIssue()],
      backlog: [makeIssue({ priority: 2 })],
      proposedCount: 6,
    });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    expect(decisions.some((d) => d.agent === "foreman-triage")).toBe(false);
    expect(decisions.some((d) => d.agent === "foreman-refine")).toBe(true);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "triage", code: "backpressure-proposals" }));
  });
});

// ---- WIP ----------------------------------------------------------------------

describe("nextActions — WIP", () => {
  it("wipGlobal reached by implement alone starves refine (SPEC §17.6: correct)", () => {
    const config = makeConfig({ wipGlobal: 3, wip: { triage: 1, refine: 2, implement: 3, review: 2 } });
    const bookkeeping = freshBookkeeping();
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-900", dispatchId: "d1", startedAt: NOW.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-901", dispatchId: "d2", startedAt: NOW.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-902", dispatchId: "d3", startedAt: NOW.toISOString(), stage: "implement" });

    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })] });
    const { decisions, skipped } = nextActions(snapshot, config, bookkeeping, NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "wip-global-full" }));
  });

  it("per-stage sub-limit caps a stage independently of the global cap", () => {
    const config = makeConfig({ wipGlobal: 10, wip: { triage: 1, refine: 1, implement: 3, review: 2 } });
    const bookkeeping = freshBookkeeping();
    bookkeeping.recordDispatch({ agent: "foreman-refine", issueId: "ENG-800", dispatchId: "d1", startedAt: NOW.toISOString(), stage: "refine" });

    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })] });
    const { decisions, skipped } = nextActions(snapshot, config, bookkeeping, NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "wip-stage-full" }));
  });
});

// ---- readyBufferTarget --------------------------------------------------------

describe("nextActions — refine buffer depth", () => {
  it("idles once the Ready buffer is at target", () => {
    const config = makeConfig({ readyBufferTarget: 5 });
    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })], readyBufferCount: 5 });
    const { decisions, skipped } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(0);
    expect(skipped).toContainEqual(expect.objectContaining({ stage: "refine", code: "buffer-satisfied" }));
  });

  it("dispatches when below target", () => {
    const config = makeConfig({ readyBufferTarget: 5 });
    const snapshot = emptySnapshot({ backlog: [makeIssue({ priority: 2 })], readyBufferCount: 2 });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions.some((d) => d.agent === "foreman-refine")).toBe(true);
  });
});

// ---- autonomy staging -----------------------------------------------------

describe("nextActions — stage permission", () => {
  it("read-only permits only triage and review", () => {
    const config = makeConfig({ stage: "read-only" });
    const snapshot = emptySnapshot({
      inbox: [makeIssue()],
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    const agents = new Set(decisions.map((d) => d.agent));
    expect(agents.has("foreman-triage")).toBe(true);
    expect(agents.has("foreman-review")).toBe(true);
    expect(agents.has("foreman-refine")).toBe(false);
    expect(agents.has("foreman-implement")).toBe(false);
  });

  it("full permits all four", () => {
    const config = makeConfig({ stage: "full", wipGlobal: 10 });
    const snapshot = emptySnapshot({
      inbox: [makeIssue()],
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    const agents = new Set(decisions.map((d) => d.agent));
    expect(agents.size).toBe(4);
  });
});

// ---- ordering -----------------------------------------------------------------

describe("nextActions — ordering by priority then age", () => {
  it("higher priority (lower rank value) goes first within a stage", () => {
    const config = makeConfig({ wip: { triage: 1, refine: 1, implement: 3, review: 2 }, wipGlobal: 10 });
    const low = makeIssue({ identifier: "ENG-10", priority: 4, createdAt: "2026-01-01T00:00:00.000Z" });
    const urgent = makeIssue({ identifier: "ENG-11", priority: 1, createdAt: "2026-01-02T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [low, urgent] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    // wip.refine is 1, so only the highest-priority candidate is dispatched.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-11");
  });

  it("older issues go first at equal priority", () => {
    const config = makeConfig({ wip: { triage: 1, refine: 1, implement: 3, review: 2 }, wipGlobal: 10 });
    const newer = makeIssue({ identifier: "ENG-20", priority: 2, createdAt: "2026-03-01T00:00:00.000Z" });
    const older = makeIssue({ identifier: "ENG-21", priority: 2, createdAt: "2026-01-01T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [newer, older] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-21");
  });

  it("unprioritized (None) issues never get picked ahead of a prioritized one", () => {
    const config = makeConfig({ wip: { triage: 1, refine: 1, implement: 3, review: 2 }, wipGlobal: 10 });
    const none = makeIssue({ identifier: "ENG-30", priority: 0, createdAt: "2026-01-01T00:00:00.000Z" });
    const low = makeIssue({ identifier: "ENG-31", priority: 4, createdAt: "2026-06-01T00:00:00.000Z" });
    const snapshot = emptySnapshot({ backlog: [none, low] });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), NOW);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.issueId).toBe("ENG-31");
  });
});

// ---- non-goal: no merge -------------------------------------------------------

describe("nextActions — never produces a merge decision", () => {
  it("no decision's agent or command ever names merge", () => {
    const config = makeConfig({ stage: "full" });
    const snapshot = emptySnapshot({
      inbox: [makeIssue()],
      backlog: [makeIssue({ priority: 2 })],
      todo: [makeTodoIssue()],
      reviewCandidates: [makeReviewCandidate()],
    });
    const { decisions } = nextActions(snapshot, config, freshBookkeeping(), new Date("2026-06-01T08:00:00.000Z"));
    for (const decision of decisions) {
      expect(decision.command.toLowerCase()).not.toContain("merge");
      expect(String(decision.agent).toLowerCase()).not.toContain("merge");
    }
  });
});
