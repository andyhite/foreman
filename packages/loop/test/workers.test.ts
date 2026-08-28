import { describe, expect, it } from "bun:test";
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
  TeamRef,
  WorkflowState,
} from "@foreman/core";
import { AGENT_LABEL, LinearApiError, TYPE_LABEL } from "@foreman/core";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { implementWorker } from "../src/workers/implement.ts";
import { refineWorker } from "../src/workers/refine.ts";
import type { WorkerContext } from "../src/workers/types.ts";

// ---- fixtures --------------------------------------------------------------

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    repos: {},
    loop: {
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
    },
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

/** Minimal `LinearWriter` stub: only `issues` and `projectInitiative` are exercised. */
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
  async project(): Promise<Project | null> {
    return null;
  }
  async projectInitiatives(): Promise<InitiativeRef[]> {
    throw new Error("not used in these tests");
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
  async deleteRelation(): Promise<void> {}
  async createLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
  async ensureLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
}

function makeContext(linear: LinearWriter, config: GlobalConfig, dispatcher: Dispatcher): WorkerContext {
  return {
    config,
    bookkeeping: freshBookkeeping(),
    dispatcher,
    linear,
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: () => {},
    dryRun: false,
  };
}


// ---- implement worker -------------------------------------------------------

describe("implementWorker — repo resolution (SPEC §3.5 item 6, §4.0)", () => {
  it("reports an unresolved-repo skip, not a thrown tick, when the project's initiative is ambiguous", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => {
      throw new LinearApiError("Project belongs to 2 initiatives", null, null);
    });
    const config = makeConfig({ repos: {} });
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher);

    const report = await implementWorker.run(ctx);

    expect(report.errors).toEqual([]);
    expect(dispatcher.calls).toEqual([]);
    expect(report.skipped).toContainEqual({
      stage: "implement",
      issueId: issue.identifier,
      code: "unresolved-repo",
      message: "Project belongs to 2 initiatives",
    });
  });

  it("reports an unresolved-repo skip when the resolved initiative is absent from config.repos", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const config = makeConfig({ repos: {} }); // no "initiative-1" entry
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher);

    const report = await implementWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "unresolved-repo");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
    expect(skip?.message).toContain("initiative-1");
  });

  it("dispatches with the mapped repo path when the initiative resolves cleanly", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-1", name: "Product" }));
    const config = makeConfig({ repos: { "initiative-1": "/repos/product" } });
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher);

    const report = await implementWorker.run(ctx);

    expect(report.skipped.some((s) => s.code === "unresolved-repo")).toBe(false);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.cwd).toBe("/repos/product");
  });
});

// ---- refine worker -----------------------------------------------------------

describe("refineWorker — repo resolution (SPEC §3.5 item 6, §4.0)", () => {
  it("reports an unresolved-repo skip when the initiative is missing from config.repos", async () => {
    const issue = makeIssue({
      state: { id: "state-0", name: "Backlog", type: "backlog", position: 0 },
      priority: 2,
      labels: [{ id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null }],
    });
    const linear = new FakeLinear([issue], async () => ({ id: "initiative-2", name: "Product" }));
    const config = makeConfig({ repos: {} });
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher);

    const report = await refineWorker.run(ctx);

    expect(dispatcher.calls).toEqual([]);
    const skip = report.skipped.find((s) => s.code === "unresolved-repo");
    expect(skip).toBeDefined();
    expect(skip?.issueId).toBe(issue.identifier);
  });

  it("still uses the scratch directory for a project-less issue rather than skipping", async () => {
    const issue = makeIssue({
      state: { id: "state-0", name: "Backlog", type: "backlog", position: 0 },
      priority: 2,
      project: null,
      labels: [{ id: `label-${TYPE_LABEL.feature}`, name: TYPE_LABEL.feature, parentId: null }],
    });
    const linear = new FakeLinear([issue], async () => {
      throw new Error("must not be called when the issue has no project");
    });
    const config = makeConfig({ repos: {} });
    const dispatcher = new FakeDispatcher();
    const ctx = makeContext(linear, config, dispatcher);

    const report = await refineWorker.run(ctx);

    expect(report.skipped.some((s) => s.code === "unresolved-repo")).toBe(false);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.cwd).toContain("scratch");
  });
});
