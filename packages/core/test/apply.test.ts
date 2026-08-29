import { describe, expect, it } from "bun:test";
import { AGENT_LABEL, MARKER_KIND, PRIORITY, TYPE_LABEL, encodeMarker } from "../src/index.ts";
import type {
  Comment,
  CreateIssueInput,
  Issue,
  IssueFilter,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  IssueRelationType,
  LinearId,
  LinearWriter,
  ProjectRef,
  WorkflowState,
} from "../src/index.ts";
import type { TriageItem } from "../src/schemas/triage.ts";
import { applyProposal, findApprovedUnapplied, hasLaterApplied, hasLaterReject, isCurrentlyProposed, proposalCandidates, runApplyPass } from "../src/apply/proposals.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: "Backlog", type: "backlog", position: 1 };

function label(name: string): IssueLabel {
  return { id: `label-${name}`, name, parentId: null };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: "## Context\nWhy.\n\n## Acceptance Criteria\n- [ ] Does the thing\n",
    priority: PRIORITY.Medium,
    estimate: 2,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_TODO,
    labels: [label(TYPE_LABEL.feature)],
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

function makeTriageItem(overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    issueId: "ENG-1",
    type: TYPE_LABEL.feature,
    proposedPriority: PRIORITY.Medium,
    severityReasoning: "Seems fine.",
    duplicateOf: null,
    proposedBlockedBy: [],
    destinationProject: null,
    destination: "Backlog",
    reproConfidence: "not-attempted",
    missingInfo: [],
    triageLabel: null,
    ...overrides,
  };
}

function proposalComment(item: TriageItem, createdAt: string): Comment {
  return { id: `comment-proposal-${createdAt}`, body: encodeMarker(MARKER_KIND.proposal, item, "human text"), createdAt, user: null, parentId: null };
}

class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  labelsById = new Map<string, IssueLabel>();
  projectsList: ProjectRef[] = [];
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  relationCalls: Array<{ issueId: string; relatedIssueId: string; type: IssueRelationType }> = [];
  issuesCalls: IssueQuery[] = [];
  createProjectCalls: Array<{ name: string; teamIds: LinearId[]; description?: string; content?: string }> = [];
  addProjectToInitiativeCalls: Array<{ projectId: LinearId; initiativeId: LinearId }> = [];

  constructor(issues: Issue[]) {
    for (const issue of issues) this.issuesById.set(issue.identifier, issue);
  }

  private byId(id: string): Issue {
    const found = [...this.issuesById.values()].find((issue) => issue.id === id);
    if (!found) throw new Error(`unknown issue id ${id}`);
    return found;
  }

  async issue(id: string): Promise<Issue | null> {
    return this.issuesById.get(id) ?? [...this.issuesById.values()].find((issue) => issue.id === id) ?? null;
  }
  async issues(query: IssueQuery): Promise<Issue[]> {
    this.issuesCalls.push(query);
    return [...this.issuesById.values()];
  }
  async comments() {
    return [];
  }
  async project() {
    return null;
  }
  async projectStatus() {
    return null;
  }
  async projectInitiatives() {
    return [];
  }
  async projectInitiative(): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async initiative() {
    return null;
  }
  async initiatives() {
    return [];
  }
  async initiativeProjects() {
    return [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [STATE_TODO, STATE_BACKLOG];
  }
  async labels(): Promise<IssueLabel[]> {
    return [...this.labelsById.values()];
  }
  async teams() {
    return [];
  }
  async projects() {
    return this.projectsList;
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = this.byId(id);
    if (input.addedLabelIds) {
      const added = input.addedLabelIds
        .map((labelId) => [...this.labelsById.values()].find((entry) => entry.id === labelId))
        .filter((entry): entry is IssueLabel => entry !== undefined);
      issue.labels = [...issue.labels, ...added];
    }
    if (input.stateId) {
      issue.state = [STATE_TODO, STATE_BACKLOG].find((state) => state.id === input.stateId) ?? issue.state;
    }
    if (input.projectId) {
      issue.project = this.projectsList.find((project) => project.id === input.projectId) ?? issue.project;
    }
    return issue;
  }
  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const created = makeIssue({ id: `created-${this.issuesById.size + 1}`, identifier: `ENG-created-${this.issuesById.size + 1}`, title: input.title });
    this.issuesById.set(created.identifier, created);
    return created;
  }
  async createProject(input: { name: string; teamIds: LinearId[]; description?: string; content?: string }): Promise<ProjectRef> {
    this.createProjectCalls.push(input);
    return { id: `project-${this.createProjectCalls.length}`, name: input.name };
  }
  async addProjectToInitiative(input: { projectId: LinearId; initiativeId: LinearId }): Promise<void> {
    this.addProjectToInitiativeCalls.push(input);
  }
  async updateProjectStatus() {}
  async createComment(input: { issueId: string; body: string; parentId?: string }) {
    this.commentCalls.push(input);
    return { id: `comment-${this.commentCalls.length}`, body: input.body, createdAt: new Date().toISOString(), user: null, parentId: input.parentId ?? null };
  }
  async createRelation(input: { issueId: string; relatedIssueId: string; type: IssueRelationType }) {
    this.relationCalls.push(input);
  }
  async deleteRelation() {}
  async createLabel(input: { name: string }): Promise<IssueLabel> {
    const created = label(input.name);
    this.labelsById.set(created.id, created);
    return created;
  }
  async ensureLabel(name: string): Promise<IssueLabel> {
    const existing = [...this.labelsById.values()].find((entry) => entry.name === name);
    if (existing) return existing;
    return this.createLabel({ name });
  }
}

describe("proposalCandidates — skip predicates", () => {
  it("skips an issue that is still agent:proposed", () => {
    const item = makeTriageItem();
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.proposed)],
      comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")],
    });
    expect(isCurrentlyProposed(issue)).toBe(true);
    expect(proposalCandidates([issue])).toEqual([]);
  });

  it("skips an issue that already has a later applied marker", () => {
    const item = makeTriageItem();
    const proposedAt = "2026-01-01T00:00:00.000Z";
    const appliedAt = "2026-01-02T00:00:00.000Z";
    const issue = makeIssue({
      comments: [
        proposalComment(item, proposedAt),
        { id: "comment-applied", body: encodeMarker(MARKER_KIND.applied, { issueId: "ENG-1" }, "applied"), createdAt: appliedAt, user: null, parentId: null },
      ],
    });
    expect(hasLaterApplied(issue, proposedAt)).toBe(true);
    expect(proposalCandidates([issue])).toEqual([]);
  });

  it("skips an issue with a later reject: reply", () => {
    const item = makeTriageItem();
    const proposedAt = "2026-01-01T00:00:00.000Z";
    const rejectAt = "2026-01-02T00:00:00.000Z";
    const issue = makeIssue({
      comments: [
        proposalComment(item, proposedAt),
        { id: "comment-reject", body: "reject: not worth it", createdAt: rejectAt, user: null, parentId: null },
      ],
    });
    expect(hasLaterReject(issue, proposedAt)).toBe(true);
    expect(proposalCandidates([issue])).toEqual([]);
  });

  it("includes an approved, un-rejected, unapplied issue", () => {
    const item = makeTriageItem();
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const candidates = proposalCandidates([issue]);
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.item).toEqual(item);
    expect(candidates[0]?.proposedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("applyProposal — mutation sequence", () => {
  it("sets state, priority, type label, project, and leaves an applied marker", async () => {
    const item = makeTriageItem({
      destination: "Backlog",
      destinationProject: "roadmap",
      triageLabel: "triage:needs-info",
    });
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];

    const applied = await applyProposal(linear, { issue, item, proposedAt: "2026-01-01T00:00:00.000Z" });

    expect(applied).toEqual({ issueId: "issue-1", identifier: "ENG-1", destination: "Backlog", note: null });
    const stateMutation = linear.updateCalls.find((call) => call.input.stateId !== undefined);
    expect(stateMutation?.input.stateId).toBe(STATE_BACKLOG.id);
    expect(stateMutation?.input.priority).toBe(item.proposedPriority);
    const projectMutation = linear.updateCalls.find((call) => call.input.projectId !== undefined);
    expect(projectMutation?.input.projectId).toBe("project-roadmap");
    expect(linear.commentCalls.length).toBe(1);
    expect(linear.commentCalls[0]?.body).toContain("Applied the `type:feature` proposal");
  });

  it("creates a duplicate relation and blocker relations", async () => {
    const item = makeTriageItem({ duplicateOf: "ENG-2", proposedBlockedBy: ["ENG-3"] });
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const duplicate = makeIssue({ id: "issue-2", identifier: "ENG-2" });
    const blocker = makeIssue({ id: "issue-3", identifier: "ENG-3" });
    const linear = new FakeLinear([issue, duplicate, blocker]);

    await applyProposal(linear, { issue, item, proposedAt: "2026-01-01T00:00:00.000Z" });

    expect(linear.relationCalls).toEqual([
      { issueId: "issue-1", relatedIssueId: "issue-2", type: "duplicate" },
      { issueId: "issue-1", relatedIssueId: "issue-3", type: "blocks" },
    ]);
  });

  it("notes an unmatched destinationProject without dropping the rest of the mutation", async () => {
    const item = makeTriageItem({ destinationProject: "Nonexistent Project" });
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];

    const applied = await applyProposal(linear, { issue, item, proposedAt: "2026-01-01T00:00:00.000Z" });

    expect(applied.note).toContain("not found");
    expect(linear.updateCalls.some((call) => call.input.projectId !== undefined)).toBe(false);
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(true);
  });

  it("leaves the project unset and notes the ambiguity when two projects share a name", async () => {
    const item = makeTriageItem({ destinationProject: "Maintenance" });
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [
      { id: "project-maintenance-a", name: "Maintenance" },
      { id: "project-maintenance-b", name: "maintenance" },
    ];

    const applied = await applyProposal(linear, { issue, item, proposedAt: "2026-01-01T00:00:00.000Z" });

    expect(applied.note).toContain("ambiguous");
    expect(applied.note).toContain("Maintenance");
    expect(linear.updateCalls.some((call) => call.input.projectId !== undefined)).toBe(false);
    expect(linear.commentCalls[0]?.body).toContain("ambiguous");
  });
});

describe("findApprovedUnapplied — filter passthrough", () => {
  it("passes the caller's filter and limit through to linear.issues", async () => {
    const item = makeTriageItem();
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    const filter: IssueFilter = { team: { id: { eq: "team-1" } } };

    const candidates = await findApprovedUnapplied(linear, { filter, limit: 10 });

    expect(candidates.length).toBe(1);
    expect(linear.issuesCalls).toEqual([{ filter, includeComments: true, limit: 10 }]);
  });

  it("defaults limit to 500 and filter to undefined", async () => {
    const linear = new FakeLinear([]);
    await findApprovedUnapplied(linear);
    expect(linear.issuesCalls).toEqual([{ filter: undefined, includeComments: true, limit: 500 }]);
  });
});

describe("runApplyPass", () => {
  it("finds and applies every approved candidate", async () => {
    const item = makeTriageItem();
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);

    const applied = await runApplyPass(linear);

    expect(applied.length).toBe(1);
    expect(applied[0]?.identifier).toBe("ENG-1");
    expect(linear.updateCalls.length).toBeGreaterThan(0);
    expect(linear.commentCalls.length).toBe(1);
  });
});
