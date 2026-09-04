import { describe, expect, it } from "bun:test";
import type {
  Comment,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  IssueRelationType,
  LinearDocument,
  LinearId,
  LinearWriter,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectRelationAnchor,
  ProjectRelationType,
  ProjectStatusType,
  TeamSettings,
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
    app: null,
    ...overrides,
  };
}

/** Models only the surface `applyRoadmap` calls; every other member throws so an unexpected call fails loudly. */
class FakeLinear implements LinearWriter {
  existingProjects = new Map<string, Project>();
  createProjectCalls: Array<{ name: string; teamIds: LinearId[]; description?: string; content?: string; startDate?: string; targetDate?: string; labelIds?: LinearId[] }> = [];
  createProjectRelationCalls: Array<{ projectId: LinearId; relatedProjectId: LinearId; type: ProjectRelationType; anchorType: ProjectRelationAnchor; relatedAnchorType: ProjectRelationAnchor }> = [];
  failCreateProjectFor = new Set<string>();
  failProjectFor = new Set<string>();

  async project(projectId: string): Promise<Project | null> {
    if (this.failProjectFor.has(projectId)) {
      throw new Error(`simulated project() failure for ${projectId}`);
    }
    return this.existingProjects.get(projectId) ?? null;
  }
  async createProject(input: { name: string; teamIds: LinearId[]; description?: string; content?: string; startDate?: string; targetDate?: string; labelIds?: LinearId[] }): Promise<ProjectRef> {
    this.createProjectCalls.push(input);
    if (this.failCreateProjectFor.has(input.name)) {
      throw new Error(`simulated createProject failure for ${input.name}`);
    }
    return { id: `project-${this.createProjectCalls.length}`, name: input.name };
  }
  async createProjectRelation(input: { projectId: LinearId; relatedProjectId: LinearId; type: ProjectRelationType; anchorType: ProjectRelationAnchor; relatedAnchorType: ProjectRelationAnchor }): Promise<void> {
    this.createProjectRelationCalls.push(input);
  }

  // Unused by `applyRoadmap` — throw so an unexpected call is loud, not silent.
  async issue(): Promise<Issue | null> { throw new Error("not implemented in fake"); }
  async issues(_query: IssueQuery): Promise<Issue[]> { throw new Error("not implemented in fake"); }
  async comments(): Promise<Comment[]> { throw new Error("not implemented in fake"); }
  async teamDocuments(): Promise<LinearDocument[]> { throw new Error("not implemented in fake"); }
  async projectStatus(): Promise<never> { throw new Error("not implemented in fake"); }
  async projectRelations(): Promise<ProjectRelation[]> { throw new Error("not implemented in fake"); }
  async workflowStates(): Promise<WorkflowState[]> { throw new Error("not implemented in fake"); }
  async labels(): Promise<IssueLabel[]> { throw new Error("not implemented in fake"); }
  async teams(): Promise<never> { throw new Error("not implemented in fake"); }
  async projects(): Promise<never> { throw new Error("not implemented in fake"); }
  async teamSettings(): Promise<TeamSettings> { throw new Error("not implemented in fake"); }
  async projectLabels(): Promise<IssueLabel[]> { throw new Error("not implemented in fake"); }
  async viewerId(): Promise<string> { throw new Error("not implemented in fake"); }
  async userByEmail(): Promise<never> { throw new Error("not implemented in fake"); }
  async updateIssue(_id: string, _input: IssueMutation): Promise<Issue> { throw new Error("not implemented in fake"); }
  async createIssue(_input: CreateIssueInput): Promise<Issue> { throw new Error("not implemented in fake"); }
  async updateProjectStatus(_input: { projectId: LinearId; type: ProjectStatusType }): Promise<void> { throw new Error("not implemented in fake"); }
  async createComment(): Promise<Comment> { throw new Error("not implemented in fake"); }
  async createRelation(_input: { issueId: string; relatedIssueId: string; type: IssueRelationType }): Promise<void> { throw new Error("not implemented in fake"); }
  async createLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async ensureLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async ensureWorkspaceLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async ensureProjectLabel(): Promise<IssueLabel> { throw new Error("not implemented in fake"); }
  async createWorkflowState(): Promise<WorkflowState> { throw new Error("not implemented in fake"); }
  async updateWorkflowState(): Promise<WorkflowState> { throw new Error("not implemented in fake"); }
  async archiveWorkflowState(): Promise<void> { throw new Error("not implemented in fake"); }
  async updateTeamSettings(): Promise<void> { throw new Error("not implemented in fake"); }
  async createDocument(): Promise<LinearDocument> { throw new Error("not implemented in fake"); }
  async updateDocument(): Promise<void> { throw new Error("not implemented in fake"); }
}

function makeRoadmapResult(overrides: Partial<RoadmapResult> = {}): RoadmapResult {
  return {
    teamId: "team-1",
    proposedProjects: [makeProposedProject()],
    sourceDocument: null,
    rationale: "Because.",
    ...overrides,
  };
}

describe("applyRoadmap — creation and relations", () => {
  it("creates both projects and one dependency relation for a sibling edge", async () => {
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

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

    expect(report.createdProjects).toHaveLength(2);
    expect(linear.createProjectCalls).toHaveLength(2);
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

  it("attaches the resolved app project label when the app name is in the caller's map", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [makeProposedProject({ key: "a", name: "Project A", app: "fleet" })],
    });

    await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: { fleet: "label-fleet" } });

    expect(linear.createProjectCalls[0]?.labelIds).toEqual(["label-fleet"]);
  });

  it("reports an app name absent from the caller's map as a problem and still creates the project", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [makeProposedProject({ key: "a", name: "Project A", app: "unknown" })],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

    expect(linear.createProjectCalls[0]?.labelIds).toBeUndefined();
    expect(report.createdProjects).toHaveLength(1);
    expect(report.problems).toEqual([
      { key: "a", error: 'project "Project A" names unknown app "unknown"; created without an app label' },
    ]);
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

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

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

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

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

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

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
    linear.failCreateProjectFor.add("Project A");
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A" }),
        makeProposedProject({ key: "b", name: "Project B" }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

    expect(report.problems).toEqual([{ key: "a", error: "failed to create project: simulated createProject failure for Project A" }]);
    expect(report.createdProjects).toHaveLength(1);
    expect(report.createdProjects[0]?.key).toBe("b");
  });
});

describe("applyRoadmap — pass 1 isolation", () => {
  it("still creates every other project and reports one problem when linear.project() throws for one key", async () => {
    const linear = new FakeLinear();
    linear.failProjectFor.add("bad-existing");
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A", blockedByExisting: ["bad-existing"] }),
        makeProposedProject({ key: "b", name: "Project B" }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.key).toBe("a");
    expect(report.problems[0]?.error).toContain("failed to compute dates");
    expect(report.createdProjects).toHaveLength(2);
    expect(report.createdProjects.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("reports an unparseable calendar date as a problem instead of throwing", async () => {
    const linear = new FakeLinear();
    const result = makeRoadmapResult({
      proposedProjects: [
        makeProposedProject({ key: "a", name: "Project A", startDate: "2026-13-01", targetDate: "2026-13-15" }),
        makeProposedProject({ key: "b", name: "Project B" }),
      ],
    });

    const report = await applyRoadmap(linear, result, { teamId: "team-1", appLabelIds: {} });

    expect(report.problems).toEqual([
      { key: "a", error: "a: startDate/targetDate 2026-13-01 is not a real calendar date" },
    ]);
    expect(report.createdProjects).toHaveLength(2);
    expect(report.createdProjects.map((entry) => entry.key)).toEqual(["a", "b"]);
  });
});
