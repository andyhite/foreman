import { describe, expect, it } from "bun:test";
import type {
  Comment,
  CreateIssueInput,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  IssueRelationType,
  LinearId,
  LinearWriter,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectStatusType,
  WorkflowState,
} from "../src/index.ts";
import { ConfigError } from "../src/config/load.ts";
import { DENY_CONFIRMER, YOLO_CONFIRMER, type Confirmer } from "../src/confirm.ts";
import { ensureMaintenanceProjects, MAINTENANCE_PROJECT_NAME } from "../src/ensure.ts";

/** Models only the surface `ensureMaintenanceProjects` calls; every other member throws so an unexpected call fails loudly. */
class FakeLinear implements LinearWriter {
  initiativesById = new Map<string, Initiative>();
  projectsByInitiative = new Map<string, ProjectRef[]>();
  createProjectCalls: Array<{ name: string; teamIds: LinearId[] }> = [];
  addProjectToInitiativeCalls: Array<{ projectId: LinearId; initiativeId: LinearId }> = [];
  failAddProjectToInitiativeFor = new Set<string>();

  async initiative(initiativeId: string): Promise<Initiative | null> {
    return this.initiativesById.get(initiativeId) ?? null;
  }

  async initiativeProjects(initiativeId: string): Promise<ProjectRef[]> {
    return this.projectsByInitiative.get(initiativeId) ?? [];
  }

  async createProject(input: { name: string; teamIds: LinearId[] }): Promise<ProjectRef> {
    this.createProjectCalls.push(input);
    return { id: `project-${this.createProjectCalls.length}`, name: input.name };
  }

  async addProjectToInitiative(input: { projectId: LinearId; initiativeId: LinearId }): Promise<void> {
    this.addProjectToInitiativeCalls.push(input);
    if (this.failAddProjectToInitiativeFor.has(input.projectId)) {
      throw new Error(`simulated addProjectToInitiative failure for ${input.projectId}`);
    }
  }

  // Unused by `ensureMaintenanceProjects` — throw so an unexpected call is loud, not silent.
  async issue(): Promise<Issue | null> { throw new Error("not implemented in fake"); }
  async issues(_query: IssueQuery): Promise<Issue[]> { throw new Error("not implemented in fake"); }
  async comments(): Promise<Comment[]> { throw new Error("not implemented in fake"); }
  async project(): Promise<Project | null> { throw new Error("not implemented in fake"); }
  async projectInitiatives(): Promise<InitiativeRef[]> { throw new Error("not implemented in fake"); }
  async projectInitiative(): Promise<InitiativeRef> { throw new Error("not implemented in fake"); }
  async initiatives(): Promise<InitiativeRef[]> { throw new Error("not implemented in fake"); }
  async projectStatus(): Promise<never> { throw new Error("not implemented in fake"); }
  async projectRelations(): Promise<ProjectRelation[]> { throw new Error("not implemented in fake"); }
  async workflowStates(): Promise<WorkflowState[]> { throw new Error("not implemented in fake"); }
  async labels(): Promise<IssueLabel[]> { throw new Error("not implemented in fake"); }
  async teams(): Promise<never> { throw new Error("not implemented in fake"); }
  async projects(): Promise<never> { throw new Error("not implemented in fake"); }
  async viewerId(): Promise<string> { throw new Error("not implemented in fake"); }
  async userByEmail(): Promise<never> { throw new Error("not implemented in fake"); }
  async updateIssue(_id: string, _input: IssueMutation): Promise<Issue> { throw new Error("not implemented in fake"); }
  async createIssue(_input: CreateIssueInput): Promise<Issue> { throw new Error("not implemented in fake"); }
  async updateProjectStatus(_input: { projectId: LinearId; type: ProjectStatusType }): Promise<void> { throw new Error("not implemented in fake"); }
  async createComment(): Promise<Comment> { throw new Error("not implemented in fake"); }
  async createRelation(_input: { issueId: string; relatedIssueId: string; type: IssueRelationType }): Promise<void> { throw new Error("not implemented in fake"); }
  async deleteRelation(): Promise<void> { throw new Error("not implemented in fake"); }
  async createProjectRelation(): Promise<void> { throw new Error("not implemented in fake"); }
  async deleteProjectRelation(): Promise<void> { throw new Error("not implemented in fake"); }
  async createLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async ensureLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
}

function makeInitiative(id: string, name: string): Initiative {
  return { id, name, documents: [] };
}

describe("ensureMaintenanceProjects", () => {
  it("reports an existing Maintenance project without creating one", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));
    linear.projectsByInitiative.set("initiative-1", [{ id: "project-existing", name: "Maintenance", status: null }]);

    const reports = await ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1"], teamId: "team-1", confirmer: YOLO_CONFIRMER });

    expect(reports).toEqual([{ initiativeId: "initiative-1", initiativeName: "Foreman", projectId: "project-existing", created: false }]);
    expect(linear.createProjectCalls).toHaveLength(0);
  });

  it("matches an existing Maintenance project case-insensitively and trimmed", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));
    linear.projectsByInitiative.set("initiative-1", [{ id: "project-existing", name: "  maintenance  ", status: null }]);

    const reports = await ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1"], teamId: "team-1", confirmer: YOLO_CONFIRMER });

    expect(reports[0]).toMatchObject({ projectId: "project-existing", created: false });
    expect(linear.createProjectCalls).toHaveLength(0);
  });

  it("creates and attaches a Maintenance project when none exists and the confirmer approves", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));

    const reports = await ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1"], teamId: "team-1", confirmer: YOLO_CONFIRMER });

    expect(linear.createProjectCalls).toEqual([{ name: MAINTENANCE_PROJECT_NAME, teamIds: ["team-1"] }]);
    expect(linear.addProjectToInitiativeCalls).toEqual([{ projectId: "project-1", initiativeId: "initiative-1" }]);
    expect(reports).toEqual([{ initiativeId: "initiative-1", initiativeName: "Foreman", projectId: "project-1", created: true }]);
  });

  it("reports projectId null and created false when the operator declines, without creating anything", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));

    const reports = await ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1"], teamId: "team-1", confirmer: DENY_CONFIRMER });

    expect(linear.createProjectCalls).toHaveLength(0);
    expect(reports).toEqual([{ initiativeId: "initiative-1", initiativeName: "Foreman", projectId: null, created: false }]);
  });

  it("throws a ConfigError naming the id when a bound initiative does not resolve", async () => {
    const linear = new FakeLinear();

    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["missing-initiative"], teamId: "team-1", confirmer: YOLO_CONFIRMER }),
    ).rejects.toThrow(ConfigError);
    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["missing-initiative"], teamId: "team-1", confirmer: YOLO_CONFIRMER }),
    ).rejects.toThrow(/missing-initiative/);
  });

  it("fails loudly, naming the orphaned project id, when addProjectToInitiative fails after creation", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));
    linear.failAddProjectToInitiativeFor.add("project-1");

    await expect(
      ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1"], teamId: "team-1", confirmer: YOLO_CONFIRMER }),
    ).rejects.toThrow(/project-1/);
  });

  it("resolves every initiative independently, reporting each", async () => {
    const linear = new FakeLinear();
    linear.initiativesById.set("initiative-1", makeInitiative("initiative-1", "Foreman"));
    linear.initiativesById.set("initiative-2", makeInitiative("initiative-2", "Sidecar"));
    linear.projectsByInitiative.set("initiative-2", [{ id: "project-existing", name: "Maintenance", status: null }]);

    const reports = await ensureMaintenanceProjects(linear, { initiativeIds: ["initiative-1", "initiative-2"], teamId: "team-1", confirmer: YOLO_CONFIRMER });

    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.initiativeId === "initiative-1")).toMatchObject({ created: true });
    expect(reports.find((r) => r.initiativeId === "initiative-2")).toMatchObject({ created: false, projectId: "project-existing" });
  });
});
