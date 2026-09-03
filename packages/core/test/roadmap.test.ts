import { describe, expect, it } from "bun:test";
import type {
  Comment,
  CreateIssueInput,
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
  ProjectRelationAnchor,
  ProjectRelationType,
  ProjectStatusType,
  WorkflowState,
} from "../src/index.ts";
import { applyRoadmap } from "../src/apply/roadmap.ts";
import type { ProposedProject, RoadmapResult } from "../src/schemas/roadmap.ts";

function makeProposedProject(overrides: Partial<ProposedProject> = {}): ProposedProject {
  return {
    key: "a",
    name: "Project A",
    description: "Project A summary",
    brief: "## Overview\nBuild A.",
    blockedBy: [],
    blockedByExisting: [],
    startDate: "2026-01-01",
    targetDate: "2026-01-15",
    ...overrides,
  };
}

/** Models only the surface `applyRoadmap` calls; every other member throws so an unexpected call fails loudly. */
class FakeLinear implements LinearWriter {
  existingProjects = new Map<string, Project>();
  createProjectCalls: Array<{ name: string; teamIds: LinearId[]; description?: string; content?: string; startDate?: string; targetDate?: string }> = [];
  addProjectToInitiativeCalls: Array<{ projectId: LinearId; initiativeId: LinearId }> = [];
  createProjectRelationCalls: Array<{ projectId: LinearId; relatedProjectId: LinearId; type: ProjectRelationType; anchorType: ProjectRelationAnchor; relatedAnchorType: ProjectRelationAnchor }> = [];
  failAddProjectToInitiativeFor = new Set<string>();

  async project(projectId: string): Promise<Project | null> {
    return this.existingProjects.get(projectId) ?? null;
  }
  async createProject(input: { name: string; teamIds: LinearId[]; description?: string; content?: string; startDate?: string; targetDate?: string }): Promise<ProjectRef> {
    this.createProjectCalls.push(input);
    return { id: `project-${this.createProjectCalls.length}`, name: input.name };
  }
  async addProjectToInitiative(input: { projectId: LinearId; initiativeId: LinearId }): Promise<void> {
    this.addProjectToInitiativeCalls.push(input);
    if (this.failAddProjectToInitiativeFor.has(input.projectId)) {
      throw new Error(`simulated addProjectToInitiative failure for ${input.projectId}`);
    }
  }
  async createProjectRelation(input: { projectId: LinearId; relatedProjectId: LinearId; type: ProjectRelationType; anchorType: ProjectRelationAnchor; relatedAnchorType: ProjectRelationAnchor }): Promise<void> {
    this.createProjectRelationCalls.push(input);
  }

  // Unused by `applyRoadmap` — throw so an unexpected call is loud, not silent.
  async issue(): Promise<Issue | null> { throw new Error("not implemented in fake"); }
  async issues(_query: IssueQuery): Promise<Issue[]> { throw new Error("not implemented in fake"); }
  async comments(): Promise<Comment[]> { throw new Error("not implemented in fake"); }
  async projectInitiatives(): Promise<never> { throw new Error("not implemented in fake"); }
  async projectInitiative(): Promise<never> { throw new Error("not implemented in fake"); }
  async initiative(): Promise<never> { throw new Error("not implemented in fake"); }
  async initiatives(): Promise<never> { throw new Error("not implemented in fake"); }
  async initiativeProjects(): Promise<never> { throw new Error("not implemented in fake"); }
  async projectStatus(): Promise<never> { throw new Error("not implemented in fake"); }
  async projectRelations(): Promise<ProjectRelation[]> { throw new Error("not implemented in fake"); }
  async workflowStates(): Promise<WorkflowState[]> { throw new Error("not implemented in fake"); }
  async labels(): Promise<IssueLabel[]> { throw new Error("not implemented in fake"); }
  async teams(): Promise<never> { throw new Error("not implemented in fake"); }
  async projects(): Promise<never> { throw new Error("not implemented in fake"); }
  async viewerId(): Promise<string> { throw new Error("not implemented in fake"); }
  async updateIssue(_id: string, _input: IssueMutation): Promise<Issue> { throw new Error("not implemented in fake"); }
  async createIssue(_input: CreateIssueInput): Promise<Issue> { throw new Error("not implemented in fake"); }
  async updateProjectStatus(_input: { projectId: LinearId; type: ProjectStatusType }): Promise<void> { throw new Error("not implemented in fake"); }
  async createComment(): Promise<Comment> { throw new Error("not implemented in fake"); }
  async createRelation(_input: { issueId: string; relatedIssueId: string; type: IssueRelationType }): Promise<void> { throw new Error("not implemented in fake"); }
  async deleteRelation(): Promise<void> { throw new Error("not implemented in fake"); }
  async deleteProjectRelation(): Promise<void> { throw new Error("not implemented in fake"); }
  async createLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async ensureLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
}

function makeRoadmapResult(overrides: Partial<RoadmapResult> = {}): RoadmapResult {
  return {
    initiativeId: "initiative-1",
    proposedProjects: [makeProposedProject()],
    rationale: "Because.",
    ...overrides,
  };
}

describe("applyRoadmap — creation and relations", () => {
  it("creates both projects, attaches both to the initiative, and creates one dependency relation for a sibling edge", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A" }),
        makeProposedProject({
          key: "b",
          name: "Project B",
          blockedBy: ["a"],
          startDate: "2026-02-01",
          targetDate: "2026-02-15",
        }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.createdProjects).toHaveLength(2);
    expect(linear.createProjectCalls).toHaveLength(2);
    expect(linear.addProjectToInitiativeCalls).toEqual([
      { projectId: "project-1", initiativeId: "initiative-1" },
      { projectId: "project-2", initiativeId: "initiative-1" },
    ]);
    expect(report.relationsCreated).toEqual([{ blockerProjectId: "project-1", blockedProjectId: "project-2" }]);
    expect(linear.createProjectRelationCalls).toEqual([
      {
        projectId: "project-1",
        relatedProjectId: "project-2",
        type: "dependency",
        anchorType: "end",
        relatedAnchorType: "start",
      },
    ]);
    expect(report.problems).toEqual([]);
  });
});

describe("applyRoadmap — date clamping", () => {
  it("shifts a startDate that precedes its blocker's targetDate forward, preserving the requested duration", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A", startDate: "2026-01-01", targetDate: "2026-01-15" }),
        makeProposedProject({
          key: "b",
          name: "Project B",
          blockedBy: ["a"],
          // Starts before "a" finishes (2026-01-15) — a 14-day requested
          // duration that must survive the shift.
          startDate: "2026-01-05",
          targetDate: "2026-01-19",
        }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.dateAdjustments).toEqual([
      {
        key: "b",
        requestedStartDate: "2026-01-05",
        requestedTargetDate: "2026-01-19",
        appliedStartDate: "2026-01-16",
        appliedTargetDate: "2026-01-30",
        forcedByTargetDate: "2026-01-15",
      },
    ]);
    const secondCreateCall = linear.createProjectCalls[1];
    expect(secondCreateCall?.startDate).toBe("2026-01-16");
    expect(secondCreateCall?.targetDate).toBe("2026-01-30");
  });

  it("clamps a startDate against an existing blocker's resolved targetDate", async () => {
    const linear = new FakeLinear();
    linear.existingProjects.set("existing-1", {
      id: "existing-1",
      name: "Existing Project",
      description: null,
      content: null,
      startDate: "2025-12-01",
      targetDate: "2026-01-10",
      status: null,
      documents: [],
    });
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({
          key: "a",
          blockedByExisting: ["existing-1"],
          startDate: "2026-01-05",
          targetDate: "2026-01-19",
        }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.dateAdjustments).toEqual([
      {
        key: "a",
        requestedStartDate: "2026-01-05",
        requestedTargetDate: "2026-01-19",
        appliedStartDate: "2026-01-11",
        appliedTargetDate: "2026-01-25",
        forcedByTargetDate: "2026-01-10",
      },
    ]);
    expect(report.relationsCreated).toEqual([{ blockerProjectId: "existing-1", blockedProjectId: "project-1" }]);
  });
});

describe("applyRoadmap — problem isolation", () => {
  it("reports an unresolvable blockedByExisting id as a problem without aborting the other entries", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A", blockedByExisting: ["missing-project"] }),
        makeProposedProject({ key: "b", name: "Project B" }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.problems).toEqual([
      { key: "a", error: 'blockedByExisting project "missing-project" could not be resolved' },
    ]);
    // Both entries still get created — one bad reference isolates to its own entry.
    expect(report.createdProjects).toHaveLength(2);
    expect(report.createdProjects.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(report.relationsCreated).toEqual([]);
  });

  it("reports a failed project creation without aborting the other entries", async () => {
    const linear = new FakeLinear();
    const originalCreateProject = linear.createProject.bind(linear);
    linear.createProject = async (input) => {
      if (input.name === "Project A") throw new Error("simulated createProject failure");
      return originalCreateProject(input);
    };
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A" }),
        makeProposedProject({ key: "b", name: "Project B" }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.problems).toEqual([{ key: "a", error: "failed to create project: simulated createProject failure" }]);
    expect(report.createdProjects).toHaveLength(1);
    expect(report.createdProjects[0]?.key).toBe("b");
  });

  it("reports a failed addProjectToInitiative without discarding the created project", async () => {
    const linear = new FakeLinear();
    linear.failAddProjectToInitiativeFor.add("project-1");
    const result = makeRoadmapResult();

    const report = await applyRoadmap(linear, result, { teamId: "team-1" });

    expect(report.createdProjects).toEqual([{ key: "a", projectId: "project-1", name: "Project A" }]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.key).toBe("a");
    expect(report.problems[0]?.error).toContain("failed to attach it to initiative");
  });
});
