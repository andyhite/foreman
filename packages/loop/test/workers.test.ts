import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Comment,
  CreateIssueInput,
  Dispatcher,
  DispatchHandle,
  DispatchOutcome,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueQuery,
  LinearWriter,
  Project,
  ProjectRef,
  ProjectStatus,
  MergedRecord,
  ResolvedRepoEntry,
  TeamRef,
  WorkflowState,
} from "@foreman/core";
import {
  AGENT_LABEL,
  branchNameFor,
  DENY_CONFIRMER,
  DISPATCH_COMMAND,
  encodeMarker,
  ensureWorktree,
  MAINTENANCE_PROJECT_NAME,
  MARKER_KIND,
  TYPE_LABEL,
  worktreePathFor,
  YOLO_CONFIRMER,
} from "@foreman/core";
import type { ConfirmRequest } from "@foreman/core";
import { implementWorker } from "../src/workers/implement.ts";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { mergeDetectWorker } from "../src/workers/merge-detect.ts";
import { planWorker } from "../src/workers/plan.ts";
import { projectStatusWorker } from "../src/workers/project-status.ts";
import { refineWorker } from "../src/workers/refine.ts";
import type { WorkerContext } from "../src/workers/types.ts";

// ---- fixtures --------------------------------------------------------------

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
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
      mode: "yolo",
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
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
    },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
    ...overrides,
  };
}

/** A resolved instance entry (SPEC §3.11), the same shape `resolveRepoEntry` returns. */
function makeEntry(overrides: Partial<ResolvedRepoEntry> = {}): ResolvedRepoEntry {
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
    ...overrides,
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
    state: { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
    labels: [
      { id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null },
      { id: `label-${AGENT_LABEL.ready}`, name: AGENT_LABEL.ready, parentId: null },
    ],
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

function freshBookkeeping(): Bookkeeping {
  return Bookkeeping.load(`/nonexistent/foreman-workers-test-${issueSeq}/bookkeeping.json`);
}

class FakeDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  calls: DispatchRequest[] = [];
  /** Overridable per-test; `Dispatcher.cleanup` is optional and print mode leaves it unset by default. */
  cleanup?: (issueId: string, repoPath: string) => Promise<void>;

  async dispatch(request: DispatchRequest): Promise<DispatchHandle> {
    this.calls.push(request);
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
    return true;
  }
}

/** Minimal `LinearWriter` stub: only `issues` and the initiative lookups are exercised. */
class FakeLinear implements LinearWriter {
  constructor(
    private readonly issueList: Issue[],
    private readonly initiativeResolver: (projectId: string) => Promise<InitiativeRef>,
  ) {}

  async issue(): Promise<Issue | null> {
    return null;
  }
  async issues(_query: IssueQuery): Promise<Issue[]> {
    return this.issueList;
  }
  async comments(): Promise<Comment[]> {
    return [];
  }
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async project(): Promise<Project | null> {
    return null;
  }
  async projectStatus(): Promise<null> {
    return null;
  }
  async projectInitiatives(projectId: string): Promise<InitiativeRef[]> {
    return [await this.initiativeResolver(projectId)];
  }
  async projectInitiative(projectId: string): Promise<InitiativeRef> {
    return this.initiativeResolver(projectId);
  }
  async initiative(): Promise<Initiative | null> {
    return null;
  }
  async initiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async initiativeProjects(): Promise<never[]> {
    return [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [];
  }
  async labels(): Promise<IssueLabel[]> {
    return [];
  }
  async teams(): Promise<TeamRef[]> {
    return [];
  }
  async projects(): Promise<never[]> {
    return [];
  }
  async updateIssue(): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createComment(): Promise<Comment> {
    throw new Error("not used in these tests");
  }
  async createRelation(): Promise<void> {}
  async createProject(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async addProjectToInitiative(): Promise<void> {}
  async updateProjectStatus(): Promise<void> {}
  async deleteRelation(): Promise<void> {}
  async createLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
  async ensureLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
}

function makeContext(
  linear: LinearWriter,
  config: GlobalConfig,
  dispatcher: Dispatcher,
  entry: ResolvedRepoEntry = makeEntry(),
  confirmer: { confirm(request: ConfirmRequest): Promise<boolean> } = YOLO_CONFIRMER,
): WorkerContext {
  return {
    config,
    bookkeeping: freshBookkeeping(),
    dispatcher,
    linear,
    entry,
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: () => {},
    mode: "yolo",
    confirm: (request) => confirmer.confirm(request),
    watchSettle: () => {},
  };
}


// ---- implement worker -------------------------------------------------------

describe("implementWorker — scope resolution (SPEC §3.11)", () => {
  it("reports an out-of-scope skip when the resolved initiative is not bound to this entry", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-2", name: "Other Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await implementWorker.run(ctx);

    expect(report.errors).toEqual([]);
    expect(dispatcher.calls).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "out-of-scope");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
    expect(skip?.message).toContain("initiative-2");
  });

  it("dispatches at the entry's repo path when the initiative is bound", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath: "/repos/product" });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await implementWorker.run(ctx);

    expect(report.skipped.some((s) => s.code === "out-of-scope")).toBe(false);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.cwd).toBe("/repos/product");
  });

  it("produces zero dispatches and a dispatch-declined skip when the confirmer denies", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry, DENY_CONFIRMER);

    const report = await implementWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    expect(report.dispatched).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "dispatch-declined");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
  });

  it("dispatches normally when the confirmer accepts", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry, YOLO_CONFIRMER);

    const report = await implementWorker.run(ctx);

    expect(dispatcher.calls).toHaveLength(1);
    expect(report.dispatched).toHaveLength(1);
  });
});

// ---- refine worker -----------------------------------------------------------

describe("refineWorker — scope resolution (SPEC §3.11)", () => {
  it("reports an out-of-scope skip when the initiative is not bound to this entry", async () => {
    const issue = makeIssue({
      state: { id: "state-0", name: "Backlog", type: "backlog", position: 0 },
      priority: 2,
      labels: [{ id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null }],
    });
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-2", name: "Other Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await refineWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "out-of-scope");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
  });

  it("reports an out-of-scope skip, with a no-project reason, for a project-less issue", async () => {
    const issue = makeIssue({
      state: { id: "state-0", name: "Backlog", type: "backlog", position: 0 },
      priority: 2,
      project: null,
      labels: [{ id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null }],
    });
    const linear = new FakeLinear([issue], async () => {
      throw new Error("must not be called when the issue has no project");
    });
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await refineWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "out-of-scope");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
  });

  it("dispatches at the entry's repo path when the initiative is bound", async () => {
    const issue = makeIssue({
      state: { id: "state-0", name: "Backlog", type: "backlog", position: 0 },
      priority: 2,
      labels: [{ id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null }],
    });
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath: "/repos/product" });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await refineWorker.run(ctx);

    expect(report.skipped.some((s) => s.code === "out-of-scope")).toBe(false);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.cwd).toBe("/repos/product");
  });
});

// ---- plan worker --------------------------------------------------------------

/**
 * Query-aware stub: `initiativeProjects` returns configured projects per
 * initiative, and `issues` inspects `query.filter` to answer either "does
 * this project have any issues" or the blocked-human count — the two shapes
 * `workers/plan.ts` actually issues.
 */
class PlanFakeLinear implements LinearWriter {
  updateProjectStatusCalls: Array<{ projectId: string; type: string }> = [];

  constructor(
    private readonly projectsByInitiative: Record<string, ProjectRef[]>,
    private readonly issuesByProject: Record<string, Issue[]> = {},
    private readonly statusByProject: Record<string, ProjectStatus> = {},
  ) {}

  async issue(): Promise<Issue | null> {
    return null;
  }
  async issues(query: IssueQuery): Promise<Issue[]> {
    const filter = query.filter as { project?: { id?: { eq?: string } } } | undefined;
    const projectId = filter?.project?.id?.eq;
    if (projectId) return this.issuesByProject[projectId] ?? [];
    return []; // BLOCKED_HUMAN_FILTER — no blocked-human issues in these tests.
  }
  async comments(): Promise<Comment[]> {
    return [];
  }
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async project(): Promise<Project | null> {
    return null;
  }
  async projectStatus(projectId: string): Promise<ProjectStatus | null> {
    return this.statusByProject[projectId] ?? null;
  }
  async projectInitiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async projectInitiative(): Promise<InitiativeRef> {
    throw new Error("not used in these tests");
  }
  async initiative(): Promise<Initiative | null> {
    return null;
  }
  async initiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async initiativeProjects(initiativeId: string): Promise<ProjectRef[]> {
    return this.projectsByInitiative[initiativeId] ?? [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [];
  }
  async labels(): Promise<IssueLabel[]> {
    return [];
  }
  async teams(): Promise<TeamRef[]> {
    return [];
  }
  async projects(): Promise<never[]> {
    return [];
  }
  async updateIssue(): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createComment(): Promise<Comment> {
    throw new Error("not used in these tests");
  }
  async createRelation(): Promise<void> {}
  async createProject(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async addProjectToInitiative(): Promise<void> {}
  async updateProjectStatus(input: { projectId: string; type: string }): Promise<void> {
    this.updateProjectStatusCalls.push(input);
  }
  async deleteRelation(): Promise<void> {}
  async createLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
  async ensureLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
}

describe("planWorker — bare-project discovery (SPEC §7.6)", () => {
  it("dispatches foreman-plan at a project with zero issues", async () => {
    const bareProject: ProjectRef = { id: "project-bare", name: "Search revamp" };
    const linear = new PlanFakeLinear({ "initiative-1": [bareProject] });
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath: "/repos/product" });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await planWorker.run(ctx);

    expect(report.errors).toEqual([]);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({ agent: "foreman-plan", cwd: "/repos/product" });
    expect(dispatcher.calls[0]?.command).toBe(`${DISPATCH_COMMAND.plan} ${bareProject.id}`);
  });

  it("never dispatches at a project that already has at least one issue", async () => {
    const seededProject: ProjectRef = { id: "project-seeded", name: "Already started" };
    const linear = new PlanFakeLinear(
      { "initiative-1": [seededProject] },
      { "project-seeded": [makeIssue({ project: seededProject })] },
    );
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await planWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    expect(report.dispatched).toEqual([]);
  });

  it("never dispatches at the standing Maintenance project, even when bare", async () => {
    const maintenance: ProjectRef = { id: "project-maintenance", name: MAINTENANCE_PROJECT_NAME };
    const linear = new PlanFakeLinear({ "initiative-1": [maintenance] });
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    const report = await planWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("records the dispatch under stage 'plan' with the project id, not an issue id", async () => {
    const bareProject: ProjectRef = { id: "project-bare", name: "Search revamp" };
    const linear = new PlanFakeLinear({ "initiative-1": [bareProject] });
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher, entry);

    await planWorker.run(ctx);

    expect(ctx.bookkeeping.countInFlight("plan")).toBe(1);
    expect(ctx.bookkeeping.inFlightProjectIds("plan").has(bareProject.id)).toBe(true);
  });
});

// ---- project-status worker --------------------------------------------------

describe("projectStatusWorker — Linear status sync (SPEC §7.6a)", () => {
  it("advances a planned project to started once an issue goes active", async () => {
    const project: ProjectRef = { id: "project-1", name: "Search revamp" };
    const linear = new PlanFakeLinear(
      { "initiative-1": [project] },
      { "project-1": [makeIssue({ state: { id: "s", name: "In Progress", type: "started", position: 3 } })] },
      { "project-1": { id: "status-planned", name: "Planned", type: "planned" } },
    );
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry);

    const report = await projectStatusWorker.run(ctx);

    expect(report.errors).toEqual([]);
    expect(linear.updateProjectStatusCalls).toEqual([{ projectId: "project-1", type: "started" }]);
  });

  it("does not touch a project already at the status nextProjectStatus would pick", async () => {
    const project: ProjectRef = { id: "project-1", name: "Search revamp" };
    const linear = new PlanFakeLinear(
      { "initiative-1": [project] },
      { "project-1": [makeIssue({ state: { id: "s", name: "Todo", type: "unstarted", position: 2 } })] },
      { "project-1": { id: "status-planned", name: "Planned", type: "planned" } },
    );
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry);

    await projectStatusWorker.run(ctx);

    expect(linear.updateProjectStatusCalls).toEqual([]);
  });

  it("never touches the standing Maintenance project", async () => {
    const maintenance: ProjectRef = { id: "project-maintenance", name: MAINTENANCE_PROJECT_NAME };
    const linear = new PlanFakeLinear(
      { "initiative-1": [maintenance] },
      { "project-maintenance": [makeIssue({ state: { id: "s", name: "Done", type: "completed", position: 5 } })] },
      { "project-maintenance": { id: "status-started", name: "Started", type: "started" } },
    );
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry);

    await projectStatusWorker.run(ctx);

    expect(linear.updateProjectStatusCalls).toEqual([]);
  });

  it("does not mutate the project status when the confirmer declines", async () => {
    const project: ProjectRef = { id: "project-1", name: "Search revamp" };
    const linear = new PlanFakeLinear(
      { "initiative-1": [project] },
      { "project-1": [makeIssue({ state: { id: "s", name: "Done", type: "completed", position: 5 } })] },
      { "project-1": { id: "status-started", name: "Started", type: "started" } },
    );
    const entry = makeEntry({ initiativeIds: ["initiative-1"] });
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry, DENY_CONFIRMER);

    await projectStatusWorker.run(ctx);

    expect(linear.updateProjectStatusCalls).toEqual([]);
  });
});

// ---- merge-detect worker -----------------------------------------------------

/** Minimal `LinearWriter` stub for merge-detect: a fixed In Review issue list, and a recorded `updateIssue` call. */
class MergeDetectFakeLinear implements LinearWriter {
  updateIssueCalls: Array<{ id: string; stateId: string }> = [];

  constructor(private readonly inReview: Issue[]) {}

  async issue(): Promise<Issue | null> {
    return null;
  }
  async issues(): Promise<Issue[]> {
    return this.inReview;
  }
  async comments(): Promise<Comment[]> {
    return [];
  }
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async project(): Promise<Project | null> {
    return null;
  }
  async projectStatus(): Promise<null> {
    return null;
  }
  async projectInitiatives(): Promise<InitiativeRef[]> {
    return [{ id: "initiative-1", name: "Product" }];
  }
  async projectInitiative(): Promise<InitiativeRef> {
    throw new Error("not used in these tests");
  }
  async initiative(): Promise<Initiative | null> {
    return null;
  }
  async initiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async initiativeProjects(): Promise<never[]> {
    return [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [{ id: "state-done", name: "Done", type: "completed", position: 1 }];
  }
  async labels(): Promise<IssueLabel[]> {
    return [];
  }
  async teams(): Promise<TeamRef[]> {
    return [];
  }
  async projects(): Promise<never[]> {
    return [];
  }
  async updateIssue(id: string, input: { stateId?: string }): Promise<Issue> {
    this.updateIssueCalls.push({ id, stateId: input.stateId ?? "" });
    throw new Error("caller only inspects updateIssueCalls in these tests");
  }
  async createIssue(): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createComment(): Promise<Comment> {
    throw new Error("not used in these tests");
  }
  async createRelation(): Promise<void> {}
  async createProject(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async addProjectToInitiative(): Promise<void> {}
  async updateProjectStatus(): Promise<void> {}
  async deleteRelation(): Promise<void> {}
  async createLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
  async ensureLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
}

/** A merged-marker comment authored by the bot, matching the issue's direct branch and base — the shape `/foreman:merge` writes. */
function mergedMarkerComment(issue: Issue, entry: ResolvedRepoEntry): Comment {
  const branch = branchNameFor(entry.branchPattern, issue, entry.repoPath);
  const record: MergedRecord = {
    issueId: issue.identifier,
    branch,
    baseBranch: entry.baseBranch,
    mergeCommit: "deadbeef",
    strategy: "squash",
    mergedAt: "2026-06-01T00:00:00.000Z",
  };
  return {
    id: "comment-1",
    body: encodeMarker(MARKER_KIND.merged, record, "Merged."),
    createdAt: "2026-06-01T00:00:00.000Z",
    user: { id: "bot-1", name: "bot", displayName: "bot" },
    parentId: null,
  };
}

describe("mergeDetectWorker — confirmation gate (SPEC §17.9)", () => {
  it("does not call updateIssue when the confirmer denies", async () => {
    const entry = makeEntry({ initiativeIds: ["initiative-1"], pr: { required: false, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } });
    issue.comments = [mergedMarkerComment(issue, entry)];
    const linear = new MergeDetectFakeLinear([issue]);
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry, DENY_CONFIRMER);

    const report = await mergeDetectWorker.run(ctx);

    expect(linear.updateIssueCalls).toEqual([]);
    expect(report.skipped.some((s) => s.code === "linear-write-declined")).toBe(true);
  });

  it("calls updateIssue when the confirmer accepts", async () => {
    const entry = makeEntry({ initiativeIds: ["initiative-1"], pr: { required: false, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } });
    issue.comments = [mergedMarkerComment(issue, entry)];
    const linear = new MergeDetectFakeLinear([issue]);
    const ctx = makeContext(linear, makeConfig(), new FakeDispatcher(), entry, YOLO_CONFIRMER);

    await mergeDetectWorker.run(ctx);

    expect(linear.updateIssueCalls).toEqual([{ id: issue.id, stateId: "state-done" }]);
  });
});

describe("mergeDetectWorker — worktree/herdr cleanup (SPEC §12)", () => {
  let repoRoot: string;
  let repoPath: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "foreman-merge-detect-")));
    repoPath = join(repoRoot, "repo");
    execFileSync("git", ["init", "--initial-branch=main", repoPath], { encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, encoding: "utf8" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: repoPath, encoding: "utf8" });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Like `MergeDetectFakeLinear`, but `updateIssue` actually succeeds — needed here since the code under test keeps going after the Done transition. */
  class SucceedingFakeLinear extends MergeDetectFakeLinear {
    override async updateIssue(id: string, input: { stateId?: string }): Promise<Issue> {
      this.updateIssueCalls.push({ id, stateId: input.stateId ?? "" });
      return { ...makeIssue(), id, state: { id: input.stateId ?? "", name: "Done", type: "completed", position: 1 } };
    }
  }

  function contextWithLog(linear: LinearWriter, config: GlobalConfig, dispatcher: Dispatcher, entry: ResolvedRepoEntry): { ctx: WorkerContext; logs: string[] } {
    const logs: string[] = [];
    const ctx: WorkerContext = {
      config,
      bookkeeping: freshBookkeeping(),
      dispatcher,
      linear,
      entry,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      log: (message) => logs.push(message),
      mode: "yolo",
      confirm: (request) => YOLO_CONFIRMER.confirm(request),
      watchSettle: () => {},
    };
    return { ctx, logs };
  }

  it("removes the merged issue's clean worktree and closes its dispatcher tab", async () => {
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath, pr: { required: false, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } });
    issue.comments = [mergedMarkerComment(issue, entry)];
    const worktreePath = worktreePathFor(entry.worktreePattern, repoPath, issue);
    await ensureWorktree({ repoPath, worktreePath, branch: "wt-branch", baseBranch: "main" });
    const linear = new SucceedingFakeLinear([issue]);
    const dispatcher = new FakeDispatcher();
    const cleanupCalls: Array<{ issueId: string; repoPath: string }> = [];
    dispatcher.cleanup = async (issueId, dispatchRepoPath) => {
      cleanupCalls.push({ issueId, repoPath: dispatchRepoPath });
    };
    const { ctx } = contextWithLog(linear, makeConfig(), dispatcher, entry);

    await mergeDetectWorker.run(ctx);

    expect(existsSync(worktreePath)).toBe(false);
    expect(cleanupCalls).toEqual([{ issueId: issue.identifier, repoPath }]);
  });

  it("leaves a dirty worktree in place and logs why", async () => {
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath, pr: { required: false, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } });
    issue.comments = [mergedMarkerComment(issue, entry)];
    const worktreePath = worktreePathFor(entry.worktreePattern, repoPath, issue);
    await ensureWorktree({ repoPath, worktreePath, branch: "wt-branch", baseBranch: "main" });
    writeFileSync(join(worktreePath, "scratch.txt"), "wip");
    const linear = new SucceedingFakeLinear([issue]);
    const { ctx, logs } = contextWithLog(linear, makeConfig(), new FakeDispatcher(), entry);

    await mergeDetectWorker.run(ctx);

    expect(existsSync(worktreePath)).toBe(true);
    expect(logs.some((line) => line.includes("uncommitted changes"))).toBe(true);
  });

  it("skips cleanup entirely when loop.cleanupMergedWorktrees is false", async () => {
    const entry = makeEntry({ initiativeIds: ["initiative-1"], repoPath, pr: { required: false, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: { id: "state-review", name: "In Review", type: "started", position: 3 } });
    issue.comments = [mergedMarkerComment(issue, entry)];
    const worktreePath = worktreePathFor(entry.worktreePattern, repoPath, issue);
    await ensureWorktree({ repoPath, worktreePath, branch: "wt-branch", baseBranch: "main" });
    const linear = new SucceedingFakeLinear([issue]);
    const config = makeConfig({ loop: { ...makeConfig().loop, cleanupMergedWorktrees: false } });
    const { ctx, logs } = contextWithLog(linear, config, new FakeDispatcher(), entry);

    await mergeDetectWorker.run(ctx);

    expect(existsSync(worktreePath)).toBe(true);
    expect(logs).toEqual([]);
  });
});
