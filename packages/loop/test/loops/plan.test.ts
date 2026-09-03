import { describe, expect, it } from "bun:test";
import type { Issue, ProjectRef, ProjectRelation, ResolvedRepoEntry, WorkflowState } from "@foreman/core";
import type { LoopContext } from "../../src/engine.ts";
import { PLAN_LOOP } from "../../src/loops/plan.ts";
import { FakeLinear } from "../fake-linear.ts";

const STATE_TRIAGE: WorkflowState = { id: "state-triage", name: "Triage", type: "triage", position: 0 };
const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: "Backlog", type: "backlog", position: 1 };
const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: null,
    priority: 3,
    estimate: null,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_BACKLOG,
    labels: [],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "project-1", name: "Foreman" },
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ResolvedRepoEntry> = {}): ResolvedRepoEntry {
  return {
    alias: "acme",
    repoPath: "/repos/acme",
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

class PlanFakeLinear extends FakeLinear {
  #projectsByInitiative: Record<string, ProjectRef[]>;
  #relationsByProject: Record<string, ProjectRelation[]>;

  constructor(
    issues: Issue[],
    projectsByInitiative: Record<string, ProjectRef[]>,
    relationsByProject: Record<string, ProjectRelation[]> = {},
  ) {
    super(issues);
    this.#projectsByInitiative = projectsByInitiative;
    this.#relationsByProject = relationsByProject;
  }

  override async initiativeProjects(initiativeId: string): Promise<ProjectRef[]> {
    return this.#projectsByInitiative[initiativeId] ?? [];
  }

  override async projectRelations(projectId: string): Promise<ProjectRelation[]> {
    return this.#relationsByProject[projectId] ?? [];
  }
}

function makeCtx(linear: PlanFakeLinear, entry: ResolvedRepoEntry, triageBatch = 10): LoopContext {
  return {
    linear,
    github: {} as LoopContext["github"],
    entry,
    config: { loop: { triageBatch } } as unknown as LoopContext["config"],
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  };
}

describe("PLAN_LOOP — refine rule", () => {
  it("proposes a refine candidate for an unblocked, unassigned Backlog issue", async () => {
    const entry = makeEntry();
    const linear = new PlanFakeLinear([makeIssue()], {});
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const refineRule = PLAN_LOOP.rules.find((rule) => rule.name === "refine")!;
    const candidates = refineRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agent).toBe("foreman-refine");
    expect(candidates[0]?.subject).toBe("ENG-1");
  });

  it("proposes a refine candidate for a Todo issue that fails the implementation gate (the legacy funnel, label-free)", async () => {
    const entry = makeEntry();
    const unrefinedTodo = makeIssue({
      id: "issue-legacy",
      identifier: "ENG-9",
      state: STATE_TODO,
      description: null,
      estimate: null,
    });
    const linear = new PlanFakeLinear([unrefinedTodo], {});
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    expect(snapshot.unrefinedTodo.map((issue) => issue.identifier)).toContain("ENG-9");
    const refineRule = PLAN_LOOP.rules.find((rule) => rule.name === "refine")!;
    const candidates = refineRule.select(snapshot);
    expect(candidates.some((c) => c.subject === "ENG-9")).toBe(true);
  });
});

describe("PLAN_LOOP — plan rule", () => {
  it("proposes a plan candidate for a Backlog project with no dependency blockers and no issues yet", async () => {
    const entry = makeEntry();
    const project: ProjectRef = { id: "project-1", name: "Foreman v2", status: { id: "status-backlog", name: "Backlog", type: "backlog" } };
    const linear = new PlanFakeLinear([], { "initiative-1": [project] });
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const planRule = PLAN_LOOP.rules.find((rule) => rule.name === "plan")!;
    const candidates = planRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agent).toBe("foreman-plan");
    expect(candidates[0]?.subject).toBe("project-1");
  });

  it("does not propose a plan candidate for a project with an unshipped dependency predecessor", async () => {
    const entry = makeEntry();
    const project: ProjectRef = { id: "project-2", name: "Foreman v3", status: { id: "status-backlog", name: "Backlog", type: "backlog" } };
    const relation: ProjectRelation = {
      id: "rel-1",
      type: "dependency",
      direction: "incoming",
      anchor: "start",
      otherAnchor: "end",
      other: { id: "project-1", name: "Foreman v2", status: { id: "status-started", name: "In Progress", type: "started" } },
    };
    const linear = new PlanFakeLinear([], { "initiative-1": [project] }, { "project-2": [relation] });
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const planRule = PLAN_LOOP.rules.find((rule) => rule.name === "plan")!;
    expect(planRule.select(snapshot)).toHaveLength(0);
  });

  it("does not propose a plan candidate for a Backlog project that already has an issue in scope", async () => {
    const entry = makeEntry();
    const project: ProjectRef = { id: "project-1", name: "Foreman v2", status: { id: "status-backlog", name: "Backlog", type: "backlog" } };
    const existingIssue = makeIssue({ id: "issue-existing", identifier: "ENG-5", project: { id: "project-1", name: "Foreman v2" } });
    const linear = new PlanFakeLinear([existingIssue], { "initiative-1": [project] });
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const planRule = PLAN_LOOP.rules.find((rule) => rule.name === "plan")!;
    expect(planRule.select(snapshot)).toHaveLength(0);
  });

  it("never proposes a plan candidate for the standing Maintenance project, regardless of issue count", async () => {
    const entry = makeEntry();
    const maintenance: ProjectRef = { id: "project-maint", name: "Maintenance", status: { id: "status-backlog", name: "Backlog", type: "backlog" } };
    const linear = new PlanFakeLinear([], { "initiative-1": [maintenance] });
    const ctx = makeCtx(linear, entry);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const planRule = PLAN_LOOP.rules.find((rule) => rule.name === "plan")!;
    expect(planRule.select(snapshot)).toHaveLength(0);
  });
});

describe("PLAN_LOOP — triage rule", () => {
  it("batches up to triageBatch inbox issues into one candidate, including a project-less issue", async () => {
    const entry = makeEntry();
    const triageIssues = [
      makeIssue({ id: "t1", identifier: "ENG-10", state: STATE_TRIAGE, project: null }),
      makeIssue({ id: "t2", identifier: "ENG-11", state: STATE_TRIAGE }),
    ];
    const linear = new PlanFakeLinear(triageIssues, {});
    const ctx = makeCtx(linear, entry, 1);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    expect(snapshot.inbox.map((issue) => issue.identifier)).toContain("ENG-10");

    const triageRule = PLAN_LOOP.rules.find((rule) => rule.name === "triage")!;
    const candidates = triageRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("--initiatives initiative-1 ENG-10");
    expect(candidates[0]?.key).toBe("triage:ENG-10");
  });

  it("keys the triage candidate on the whole sorted batch, not just the head identifier", async () => {
    const entry = makeEntry();
    const triageIssues = [
      makeIssue({ id: "t1", identifier: "ENG-20", state: STATE_TRIAGE }),
      makeIssue({ id: "t2", identifier: "ENG-10", state: STATE_TRIAGE }),
    ];
    const linear = new PlanFakeLinear(triageIssues, {});
    const ctx = makeCtx(linear, entry, 10);

    const snapshot = await PLAN_LOOP.fetch(ctx);
    const triageRule = PLAN_LOOP.rules.find((rule) => rule.name === "triage")!;
    const candidates = triageRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.key).toBe("triage:ENG-10,ENG-20");
  });
});
