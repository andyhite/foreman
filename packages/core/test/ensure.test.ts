import { describe, expect, it } from "bun:test";
import { ConfigError } from "../src/config/load.ts";
import { ensureMaintenanceProjects, MAINTENANCE_PROJECT_NAME } from "../src/ensure.ts";
import type { CreateIssueInput, IssueQuery, LinearWriter } from "../src/linear/api.ts";
import type {
  Comment,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  Project,
  ProjectRef,
  ProjectStatus,
  TeamRef,
  WorkflowState,
} from "../src/linear/types.ts";

/** Minimal in-memory `LinearWriter` fake recording every mutation call, for the ensure pass. */
class FakeLinear implements LinearWriter {
  createProjectCalls: Array<{ name: string; teamIds: string[] }> = [];
  addProjectToInitiativeCalls: Array<{ projectId: string; initiativeId: string }> = [];

  constructor(
    private readonly initiativesById: Map<string, Initiative>,
    private readonly projectsByInitiative: Map<string, ProjectRef[]>,
    private readonly failAttach: boolean = false,
  ) {}

  async issue(): Promise<Issue | null> {
    return null;
  }
  async issues(_query: IssueQuery): Promise<Issue[]> {
    return [];
  }
  async comments(): Promise<Comment[]> {
    return [];
  }
  async project(): Promise<Project | null> {
    return null;
  }
  async projectStatus(): Promise<ProjectStatus | null> {
    return null;
  }
  async projectInitiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async projectInitiative(): Promise<InitiativeRef> {
    throw new Error("not used in these tests");
  }
  async initiative(initiativeId: string): Promise<Initiative | null> {
    return this.initiativesById.get(initiativeId) ?? null;
  }
  async initiatives(): Promise<InitiativeRef[]> {
    return [...this.initiativesById.values()];
  }
  async initiativeProjects(initiativeId: string): Promise<ProjectRef[]> {
    return this.projectsByInitiative.get(initiativeId) ?? [];
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
  async projects(): Promise<ProjectRef[]> {
    return [];
  }
  async updateIssue(): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createProject(input: { name: string; teamIds: string[] }): Promise<ProjectRef> {
    this.createProjectCalls.push({ name: input.name, teamIds: input.teamIds });
    return { id: "project-created", name: input.name };
  }
  async addProjectToInitiative(input: { projectId: string; initiativeId: string }): Promise<void> {
    this.addProjectToInitiativeCalls.push(input);
    if (this.failAttach) throw new Error("initiativeToProjectCreate failed");
  }
  async updateProjectStatus(): Promise<void> {}
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

function makeInitiative(id: string, name: string): Initiative {
  return { id, name, documents: [] };
}

describe("ensureMaintenanceProjects (SPEC §3.11)", () => {
  it("no-ops when the Maintenance project already exists", async () => {
    const linear = new FakeLinear(
      new Map([["init-1", makeInitiative("init-1", "Foreman")]]),
      new Map([["init-1", [{ id: "project-1", name: "Maintenance" }]]]),
    );

    const reports = await ensureMaintenanceProjects(linear, {
      initiativeIds: ["init-1"],
      teamId: "team-1",
    });

    expect(reports).toEqual([
      { initiativeId: "init-1", initiativeName: "Foreman", projectId: "project-1", created: false },
    ]);
    expect(linear.createProjectCalls).toEqual([]);
    expect(linear.addProjectToInitiativeCalls).toEqual([]);
  });

  it("matches the Maintenance project name case-insensitively", async () => {
    const linear = new FakeLinear(
      new Map([["init-1", makeInitiative("init-1", "Foreman")]]),
      new Map([["init-1", [{ id: "project-1", name: "maintenance" }]]]),
    );

    const reports = await ensureMaintenanceProjects(linear, {
      initiativeIds: ["init-1"],
      teamId: "team-1",
    });

    expect(reports[0]).toEqual({
      initiativeId: "init-1",
      initiativeName: "Foreman",
      projectId: "project-1",
      created: false,
    });
    expect(linear.createProjectCalls).toEqual([]);
  });

  it("creates and links a Maintenance project when none exists, in order", async () => {
    const linear = new FakeLinear(
      new Map([["init-1", makeInitiative("init-1", "Foreman")]]),
      new Map([["init-1", []]]),
    );

    const reports = await ensureMaintenanceProjects(linear, {
      initiativeIds: ["init-1"],
      teamId: "team-1",
    });

    expect(linear.createProjectCalls).toEqual([{ name: MAINTENANCE_PROJECT_NAME, teamIds: ["team-1"] }]);
    expect(linear.addProjectToInitiativeCalls).toEqual([
      { projectId: "project-created", initiativeId: "init-1" },
    ]);
    expect(reports).toEqual([
      {
        initiativeId: "init-1",
        initiativeName: "Foreman",
        projectId: "project-created",
        created: true,
      },
    ]);
  });

  it("throws ConfigError naming the id when a bound initiative does not resolve", async () => {
    const linear = new FakeLinear(new Map(), new Map());

    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["ghost-init"], teamId: "team-1" }),
    ).rejects.toThrow(ConfigError);
    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["ghost-init"], teamId: "team-1" }),
    ).rejects.toThrow(/ghost-init/);
  });

  it("names the orphan project id when the attach call fails after create", async () => {
    const linear = new FakeLinear(
      new Map([["init-1", makeInitiative("init-1", "Foreman")]]),
      new Map([["init-1", []]]),
      /* failAttach */ true,
    );

    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["init-1"], teamId: "team-1" }),
    ).rejects.toThrow(/project-created/);
  });
});
