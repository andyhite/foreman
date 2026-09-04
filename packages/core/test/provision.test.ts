import { describe, expect, it } from "bun:test";
import { YOLO_CONFIRMER } from "../src/confirm.ts";
import { provisionTeam } from "../src/provision.ts";
import type {
  Comment,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueRelationType,
  LinearId,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectRelationAnchor,
  ProjectRelationType,
  ProjectStatus,
  ProjectStatusType,
  TeamRef,
  TeamSettings,
  UserRef,
  WorkflowState,
} from "../src/linear/types.ts";
import type { IssueQuery, LinearWriter } from "../src/linear/api.ts";

/** A `LinearWriter` fake that records every mutating call and mutates its own state, mirroring the fakes used in `packages/loop`/`packages/omp-plugin` tests. */
class FakeLinear implements LinearWriter {
  states: WorkflowState[];
  settings: TeamSettings;
  workspaceLabels: IssueLabel[] = [];
  workspaceProjectLabels: IssueLabel[] = [];
  createWorkflowStateCalls: Array<{ teamId: LinearId; name: string; type: string; color: string; description?: string; position?: number }> = [];
  updateWorkflowStateCalls: Array<{ id: LinearId; input: { name?: string; color?: string; description?: string; position?: number } }> = [];
  archiveWorkflowStateCalls: LinearId[] = [];
  updateTeamSettingsCalls: Array<{ teamId: LinearId; input: { triageEnabled?: boolean; cyclesEnabled?: boolean } }> = [];
  ensureWorkspaceLabelCalls: string[] = [];
  ensureProjectLabelCalls: string[] = [];

  constructor(states: WorkflowState[], settings: TeamSettings) {
    this.states = states;
    this.settings = settings;
  }

  async workflowStates(): Promise<WorkflowState[]> {
    return this.states;
  }

  async teamSettings(): Promise<TeamSettings> {
    return this.settings;
  }

  async updateTeamSettings(teamId: LinearId, input: { triageEnabled?: boolean; cyclesEnabled?: boolean }): Promise<void> {
    this.updateTeamSettingsCalls.push({ teamId, input });
    this.settings = { ...this.settings, ...input };
  }

  async createWorkflowState(input: { teamId: LinearId; name: string; type: string; color: string; description?: string; position?: number }): Promise<WorkflowState> {
    this.createWorkflowStateCalls.push(input);
    const created: WorkflowState = {
      id: `created-${input.name}`,
      name: input.name,
      type: input.type as WorkflowState["type"],
      position: input.position ?? this.states.length,
      color: input.color,
      description: input.description ?? null,
    };
    this.states.push(created);
    return created;
  }

  async updateWorkflowState(
    id: LinearId,
    input: { name?: string; color?: string; description?: string; position?: number },
  ): Promise<WorkflowState> {
    this.updateWorkflowStateCalls.push({ id, input });
    const existing = this.states.find((state) => state.id === id);
    if (!existing) throw new Error(`unknown state ${id}`);
    Object.assign(existing, input);
    return existing;
  }

  async archiveWorkflowState(id: LinearId): Promise<void> {
    this.archiveWorkflowStateCalls.push(id);
    this.states = this.states.filter((state) => state.id !== id);
  }

  async ensureWorkspaceLabel(name: string): Promise<IssueLabel> {
    this.ensureWorkspaceLabelCalls.push(name);
    const existing = this.workspaceLabels.find((label) => label.name === name);
    if (existing) return existing;
    const created: IssueLabel = { id: `label-${name}`, name, parentId: null };
    this.workspaceLabels.push(created);
    return created;
  }

  async ensureProjectLabel(name: string): Promise<IssueLabel> {
    this.ensureProjectLabelCalls.push(name);
    const existing = this.workspaceProjectLabels.find((label) => label.name === name);
    if (existing) return existing;
    const created: IssueLabel = { id: `project-label-${name}`, name, parentId: null };
    this.workspaceProjectLabels.push(created);
    return created;
  }

  // Unused LinearReader/LinearWriter members — throw to fail loudly if a test path exercises them.
  issue(): Promise<Issue | null> {
    throw new Error("not implemented");
  }
  issues(_query: IssueQuery): Promise<Issue[]> {
    throw new Error("not implemented");
  }
  comments(): Promise<Comment[]> {
    throw new Error("not implemented");
  }
  project(): Promise<Project | null> {
    throw new Error("not implemented");
  }
  projectInitiatives(): Promise<InitiativeRef[]> {
    throw new Error("not implemented");
  }
  initiative(): Promise<Initiative | null> {
    throw new Error("not implemented");
  }
  projectRelations(): Promise<ProjectRelation[]> {
    throw new Error("not implemented");
  }
  projectStatus(): Promise<ProjectStatus | null> {
    throw new Error("not implemented");
  }
  labels(): Promise<IssueLabel[]> {
    return Promise.resolve(this.workspaceLabels);
  }
  teams(): Promise<TeamRef[]> {
    throw new Error("not implemented");
  }
  projects(): Promise<ProjectRef[]> {
    throw new Error("not implemented");
  }
  projectLabels(): Promise<IssueLabel[]> {
    return Promise.resolve(this.workspaceProjectLabels);
  }
  viewerId(): Promise<string> {
    throw new Error("not implemented");
  }
  userByEmail(): Promise<UserRef | null> {
    throw new Error("not implemented");
  }
  updateIssue(): Promise<Issue> {
    throw new Error("not implemented");
  }
  createIssue(): Promise<Issue> {
    throw new Error("not implemented");
  }
  createProject(): Promise<ProjectRef> {
    throw new Error("not implemented");
  }
  updateProjectStatus(): Promise<void> {
    throw new Error("not implemented");
  }
  createComment(): Promise<Comment> {
    throw new Error("not implemented");
  }
  createRelation(_input: { issueId: string; relatedIssueId: string; type: IssueRelationType }): Promise<void> {
    throw new Error("not implemented");
  }
  createProjectRelation(_input: {
    projectId: LinearId;
    relatedProjectId: LinearId;
    type: ProjectRelationType;
    anchorType: ProjectRelationAnchor;
    relatedAnchorType: ProjectRelationAnchor;
  }): Promise<void> {
    throw new Error("not implemented");
  }
  createLabel(): Promise<IssueLabel> {
    throw new Error("not implemented");
  }
  ensureLabel(): Promise<IssueLabel> {
    throw new Error("not implemented");
  }
}

/** Linear's own stock states plus a native Duplicate — a fresh team's real shape before Foreman touches it. */
function stockStates(): WorkflowState[] {
  return [
    { id: "s-backlog", name: "Backlog", type: "backlog", position: 0, color: "#bec2c8", description: "Prioritized, not yet refined." },
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1, color: "#e2e2e2", description: null },
    { id: "s-inprogress", name: "In Progress", type: "started", position: 2, color: "#f2994a", description: "foreman-implement is working on this." },
    { id: "s-done", name: "Done", type: "completed", position: 3, color: "#5e6ad2", description: "Shipped." },
    { id: "s-canceled", name: "Canceled", type: "canceled", position: 4, color: "#95a2b3", description: "Abandoned." },
    { id: "s-duplicate", name: "Duplicate", type: "duplicate", position: 5, color: "#95a2b3", description: null },
  ];
}

function stockSettings(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return {
    id: "t1",
    key: "ENG",
    name: "Engineering",
    triageEnabled: false,
    cyclesEnabled: false,
    triageStateId: null,
    ...overrides,
  };
}

describe("provisionTeam", () => {
  it("enables triage, creates the five missing states with the right types, prunes Todo, and creates app labels", async () => {
    const linear = new FakeLinear(stockStates(), stockSettings());

    await provisionTeam(linear, { teamId: "t1", apps: ["fleet", "zero"], confirmer: YOLO_CONFIRMER });

    expect(linear.updateTeamSettingsCalls).toHaveLength(1);
    expect(linear.updateTeamSettingsCalls[0]).toEqual({ teamId: "t1", input: { triageEnabled: true } });

    expect(linear.createWorkflowStateCalls.map((c) => c.name)).toEqual([
      "Refining",
      "Needs Input",
      "Ready",
      "Blocked",
      "In Review",
    ]);
    expect(linear.createWorkflowStateCalls.map((c) => c.type)).toEqual(["unstarted", "unstarted", "unstarted", "started", "started"]);
    expect(linear.createWorkflowStateCalls.some((c) => c.name === "Duplicate")).toBe(false);

    expect(linear.archiveWorkflowStateCalls).toEqual(["s-todo"]);

    expect(linear.ensureWorkspaceLabelCalls).toEqual(["app:fleet", "app:zero", "app:all"]);
    expect(linear.ensureProjectLabelCalls).toEqual(["app:fleet", "app:zero", "app:all"]);
    expect(linear.workspaceLabels.map((l) => l.name)).toEqual(["app:fleet", "app:zero", "app:all"]);
    expect(linear.workspaceProjectLabels.map((l) => l.name)).toEqual(["app:fleet", "app:zero", "app:all"]);
  });

  it("is idempotent: a second call on the resulting state creates nothing and every action is unchanged", async () => {
    const linear = new FakeLinear(stockStates(), stockSettings());
    await provisionTeam(linear, { teamId: "t1", apps: ["fleet", "zero"], confirmer: YOLO_CONFIRMER });

    linear.createWorkflowStateCalls = [];
    linear.updateWorkflowStateCalls = [];
    linear.archiveWorkflowStateCalls = [];
    linear.updateTeamSettingsCalls = [];
    linear.ensureWorkspaceLabelCalls = [];
    linear.ensureProjectLabelCalls = [];

    const actions = await provisionTeam(linear, { teamId: "t1", apps: ["fleet", "zero"], confirmer: YOLO_CONFIRMER });

    expect(linear.createWorkflowStateCalls).toHaveLength(0);
    expect(linear.updateWorkflowStateCalls).toHaveLength(0);
    expect(linear.archiveWorkflowStateCalls).toHaveLength(0);
    expect(actions.every((action) => action.changed === false)).toBe(true);
  });

  it("reports a type mismatch without creating when a state already exists under a different type", async () => {
    const states = stockStates();
    states.push({ id: "s-ready-wrong-type", name: "Ready", type: "backlog", position: 6, color: "#000000", description: null });
    const linear = new FakeLinear(states, stockSettings());

    const actions = await provisionTeam(linear, { teamId: "t1", apps: [], confirmer: YOLO_CONFIRMER });

    expect(linear.createWorkflowStateCalls.some((c) => c.name === "Ready")).toBe(false);
    const readyAction = actions.find((action) => action.kind === "state" && action.name === "Ready");
    expect(readyAction?.changed).toBe(false);
    expect(readyAction?.detail).toContain('expected "unstarted"');
  });

  it("updates an existing managed state's color and description without recreating it", async () => {
    const states = stockStates();
    states.push({ id: "s-ready-stale", name: "Ready", type: "unstarted", position: 6, color: "#000000", description: "stale" });
    const linear = new FakeLinear(states, stockSettings());

    await provisionTeam(linear, { teamId: "t1", apps: [], confirmer: YOLO_CONFIRMER });

    expect(linear.createWorkflowStateCalls.some((c) => c.name === "Ready")).toBe(false);
    expect(linear.updateWorkflowStateCalls).toEqual([
      { id: "s-ready-stale", input: { color: "#e2e2e2", description: "Refined and implementable." } },
    ]);
  });

  it("reports when no native Duplicate-type state exists, without attempting to create one", async () => {
    const states = stockStates().filter((state) => state.type !== "duplicate");
    const linear = new FakeLinear(states, stockSettings());

    const actions = await provisionTeam(linear, { teamId: "t1", apps: [], confirmer: YOLO_CONFIRMER });

    expect(linear.createWorkflowStateCalls.some((c) => c.name === "Duplicate")).toBe(false);
    const duplicateAction = actions.find((action) => action.kind === "state" && action.name === "Duplicate");
    expect(duplicateAction?.changed).toBe(false);
    expect(duplicateAction?.detail).toContain("no native Duplicate-type state");
  });

  it("asks once for everything a call would change, and declining leaves every action unwritten", async () => {
    const linear = new FakeLinear(stockStates(), stockSettings());
    let confirmCalls = 0;
    const actions = await provisionTeam(linear, {
      teamId: "t1",
      apps: ["fleet"],
      confirmer: {
        confirm: async () => {
          confirmCalls += 1;
          return false;
        },
        close: () => {},
      },
    });

    expect(confirmCalls).toBe(1);
    expect(linear.createWorkflowStateCalls).toHaveLength(0);
    expect(linear.archiveWorkflowStateCalls).toHaveLength(0);
    expect(linear.updateTeamSettingsCalls).toHaveLength(0);
    expect(actions.some((action) => action.detail === "declined")).toBe(true);
  });
});
