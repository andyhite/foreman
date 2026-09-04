import { describe, expect, it } from "bun:test";
import { MARKER_KIND, PRIORITY, TYPE_LABEL, decodeMarker } from "@foreman/core";
import type {
  BlockRecord,
  ContextResult,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueRelationType,
  LinearDocument,
  LinearWriter,
  PlanResult,
  Project,
  RefineResult,
  ResolvedRepoEntry,
  ReviewResult,
  TeamRef,
  TriageResult,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { applyBlock, applyOutcome, type ApplyDeps } from "../src/results/apply.ts";

const STATE_READY: WorkflowState = { id: "state-ready", name: "Ready", type: "unstarted", position: 2 };
const STATE_IN_REVIEW: WorkflowState = {
  id: "state-in-review",
  name: "In Review",
  type: "started",
  position: 4,
};
const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: "Backlog", type: "backlog", position: 1 };
const STATE_NEEDS_INPUT: WorkflowState = { id: "state-needs-input", name: "Needs Input", type: "unstarted", position: 5 };
const STATE_BLOCKED: WorkflowState = { id: "state-blocked", name: "Blocked", type: "started", position: 6 };

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
    labels: [label(TYPE_LABEL.feature)],
    state: STATE_READY,
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

class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  labelsById = new Map<string, IssueLabel>();
  projectsList: { id: string; name: string }[] = [];
  projectLabelsById = new Map<string, IssueLabel>();
  projectRecord: Project | null = null;
  teamsList: TeamRef[] = [];
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  updateProjectStatusCalls: Array<{ projectId: string; type: string }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  createIssueCalls: CreateIssueInput[] = [];
  relationCalls: Array<{ issueId: string; relatedIssueId: string; type: IssueRelationType }> = [];
  documentsList: LinearDocument[] = [];
  updateDocumentCalls: Array<{ documentId: string; content: string }> = [];
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
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async userByEmail(): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async issues(): Promise<Issue[]> {
    return [...this.issuesById.values()];
  }
  async comments() {
    return [];
  }
  async project() {
    return this.projectRecord;
  }
  async projectStatus() {
    return null;
  }
  async teamDocuments(): Promise<LinearDocument[]> {
    return this.documentsList;
  }
  async createDocument(): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async updateDocument(input: { documentId: string; content: string }): Promise<void> {
    this.updateDocumentCalls.push(input);
    const doc = this.documentsList.find((entry) => entry.id === input.documentId);
    if (doc) doc.content = input.content;
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [STATE_READY, STATE_IN_REVIEW, STATE_BACKLOG, STATE_NEEDS_INPUT, STATE_BLOCKED];
  }
  async labels(): Promise<IssueLabel[]> {
    return [...this.labelsById.values()];
  }
  async teams() {
    return this.teamsList;
  }
  async projects() {
    return this.projectsList;
  }
  async teamSettings() {
    return { id: "team-1", key: "ENG", name: "Engineering", triageEnabled: true, cyclesEnabled: false, triageStateId: null };
  }
  async projectLabels(): Promise<IssueLabel[]> {
    return [...this.projectLabelsById.values()];
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
    if (input.removedLabelIds) {
      issue.labels = issue.labels.filter((entry) => !input.removedLabelIds?.includes(entry.id));
    }
    if (input.stateId) {
      issue.state = [STATE_READY, STATE_IN_REVIEW, STATE_BACKLOG, STATE_NEEDS_INPUT, STATE_BLOCKED].find((state) => state.id === input.stateId) ?? issue.state;
    }
    return issue;
  }
  async createIssue(input: CreateIssueInput): Promise<Issue> {
    this.createIssueCalls.push(input);
    const n = this.createIssueCalls.length;
    const created = makeIssue({ id: `created-${n}`, identifier: `ENG-created-${n}`, title: input.title });
    this.issuesById.set(created.identifier, created);
    return created;
  }
  async createProject(input: { name: string; teamIds: string[]; description?: string; content?: string; labelIds?: string[] }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async updateProjectStatus(input: { projectId: string; type: string }) {
    this.updateProjectStatusCalls.push(input);
  }
  async createComment(input: { issueId: string; body: string; parentId?: string }) {
    this.commentCalls.push(input);
    return { id: `comment-${this.commentCalls.length}`, body: input.body, createdAt: new Date().toISOString(), user: null, parentId: input.parentId ?? null };
  }
  async createRelation(input: { issueId: string; relatedIssueId: string; type: IssueRelationType }) {
    this.relationCalls.push(input);
  }
  async projectRelations() {
    return [];
  }
  async createProjectRelation() {}
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
  async ensureWorkspaceLabel(name: string): Promise<IssueLabel> {
    return this.ensureLabel(name);
  }
  async ensureProjectLabel(name: string): Promise<IssueLabel> {
    const existing = [...this.projectLabelsById.values()].find((entry) => entry.name === name);
    if (existing) return existing;
    const created = label(name);
    this.projectLabelsById.set(created.id, created);
    return created;
  }
  async createWorkflowState(input: { teamId: string; name: string; type: string; color: string }): Promise<WorkflowState> {
    return { id: `state-${input.name.toLowerCase()}`, name: input.name, type: input.type as WorkflowState["type"], position: 99 };
  }
  async updateWorkflowState(id: string, input: { name?: string; color?: string; description?: string }): Promise<WorkflowState> {
    return { id, name: input.name ?? id, type: "started", position: 99 };
  }
  async archiveWorkflowState(): Promise<void> {}
  async updateTeamSettings(): Promise<void> {}
}

const TEST_ENTRY: Pick<ResolvedRepoEntry, "alias" | "team" | "repoPath" | "branchPattern" | "pr"> = {
  alias: "repo",
  team: "ENG",
  repoPath: "/repo",
  branchPattern: "<issue-id>-<slug>",
  pr: { required: true, draft: false, ciRequired: true },
};

function makeDeps(
  linear: FakeLinear,
  entry?: Pick<ResolvedRepoEntry, "alias" | "team" | "repoPath" | "branchPattern" | "pr">,
  operatorUserId: string | null = null,
): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z"), entry, operatorUserId };
}

function makeTriageItem(overrides: Partial<TriageResult["items"][number]> = {}): TriageResult {
  return {
    summary: "One batch.",
    items: [
      {
        issueId: "ENG-1",
        app: null,
        type: TYPE_LABEL.feature,
        proposedPriority: PRIORITY.Medium,
        severityReasoning: "Seems fine.",
        duplicateOf: null,
        proposedBlockedBy: [],
        destination: "backlog",
        destinationProjectId: "project-1",
        newProject: null,
        missingInfo: [],
        draftDescription: null,
        proposedEstimate: null,
        ...overrides,
      },
    ],
  };
}

function makeRefineResult(overrides: Partial<RefineResult> = {}): RefineResult {
  return {
    issueId: "ENG-1",
    refinedDescription: "Body.",
    estimate: 2,
    acceptanceCriteria: ["Does the thing"],
    affectedAreas: [],
    outOfScope: [],
    subIssues: [],
    spikeCreated: null,
    readyForImplementation: true,
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    issueId: "ENG-1",
    reviewedSha: "abc123",
    criteriaVerification: [],
    dodSatisfied: true,
    dodChecklist: [],
    findings: [],
    contextContradictions: [],
    projectOrganization: "No concerns.",
    scopeCreep: [],
    testAdequacy: "Yes, tests would fail if reverted.",
    verdict: "approve",
    ...overrides,
  };
}

function makeBlockRecord(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blocked: true,
    type: "needs-decision",
    whatIWasDoing: "Implementing.",
    whatINeed: "A decision.",
    options: null,
    recommendation: null,
    stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "" },
    costOfWrongGuess: "Low.",
    blockedByIssues: [],
    ...overrides,
  } as BlockRecord;
}

describe("applyOutcome — triage", () => {
  it("backlog: sets priority/project/type label, moves to Backlog", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), { kind: "result", agent: "foreman-triage", result: makeTriageItem() });

    expect(linear.commentCalls.length).toBe(1);
    expect(linear.updateCalls.some((call) => call.input.projectId === "project-1")).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.priority === PRIORITY.Medium)).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_BACKLOG.id)).toBe(true);
  });

  it("backlog: a project-less item moves to Backlog, adds the type label, and sends no projectId", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-triage",
      result: makeTriageItem({ destinationProjectId: null }),
    });

    expect(linear.updateCalls.some((call) => "projectId" in call.input)).toBe(false);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_BACKLOG.id)).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.addedLabelIds?.includes(`label-${TYPE_LABEL.feature}`))).toBe(true);
  });

  it("cancel: moves to Needs Input, writes a block marker", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-triage",
      result: makeTriageItem({ destination: "cancel", destinationProjectId: null }),
    });

    expect(linear.commentCalls.length).toBe(1);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_NEEDS_INPUT.id)).toBe(true);
    // No operator configured: nothing to assign.
    expect(linear.updateCalls.some((call) => call.input.assigneeId !== undefined)).toBe(false);
  });

  it("cancel: assigns the block to the configured operator", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear, undefined, "operator-1"), {
      kind: "result",
      agent: "foreman-triage",
      result: makeTriageItem({ destination: "cancel", destinationProjectId: null }),
    });

    expect(linear.updateCalls.some((call) => call.input.assigneeId === "operator-1")).toBe(true);
  });

  it("an item naming an issue on another team is recorded as a failure and mutates nothing", async () => {
    const issue = makeIssue({
      state: { id: "state-triage", name: "Triage", type: "triage", position: 0 },
      team: { id: "team-2", key: "OTHR", name: "Other" },
    });
    const linear = new FakeLinear([issue]);
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      makeDeps(linear, TEST_ENTRY),
      { kind: "result", agent: "foreman-triage", result: makeTriageItem() },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
    expect(notices.some((notice) => notice.level === "error" && notice.message.includes("OTHR"))).toBe(true);
  });

  it("an item with a destinationProjectId from another team is recorded as a failure", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    // deps.entry binds team ENG, but `projects("ENG")` never lists this id.
    linear.projectsList = [];
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      makeDeps(linear, TEST_ENTRY),
      { kind: "result", agent: "foreman-triage", result: makeTriageItem({ destinationProjectId: "project-x" }) },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.updateCalls).toHaveLength(0);
    expect(notices.some((notice) => notice.level === "error" && notice.message.includes("not a project on team ENG"))).toBe(true);
  });

  it("an out-of-scope proposedBlockedBy entry yields a problems line while the rest of the item still applies", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const blocker = makeIssue({
      id: "issue-2",
      identifier: "OTHR-1",
      team: { id: "team-2", key: "OTHR", name: "Other" },
    });
    const linear = new FakeLinear([issue, blocker]);
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      makeDeps(linear, TEST_ENTRY),
      { kind: "result", agent: "foreman-triage", result: makeTriageItem({ proposedBlockedBy: ["OTHR-1"] }) },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.relationCalls).toHaveLength(0);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_BACKLOG.id)).toBe(true);
    expect(notices.some((notice) => notice.message.includes("blocker OTHR-1 is out of scope"))).toBe(true);
  });
});

describe("applyOutcome — triage is bound to its dispatched batch", () => {
  it("an item naming an issue outside batchIssueIds is reported as a failure and mutates nothing", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    const deps: ApplyDeps = { ...makeDeps(linear, TEST_ENTRY), batchIssueIds: ["ENG-9"] };
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      deps,
      { kind: "result", agent: "foreman-triage", result: makeTriageItem() },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
    expect(notices.some((notice) => notice.level === "error" && notice.message.includes("not part of this dispatch's batch"))).toBe(true);
  });

  it("an in-batch item whose issue is not in Triage is refused and mutates nothing", async () => {
    const issue = makeIssue({ state: STATE_READY });
    const linear = new FakeLinear([issue]);
    const deps: ApplyDeps = { ...makeDeps(linear, TEST_ENTRY), batchIssueIds: ["ENG-1"] };
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      deps,
      { kind: "result", agent: "foreman-triage", result: makeTriageItem() },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
    expect(notices.some((notice) => notice.level === "error" && notice.message.includes("not Triage"))).toBe(true);
  });
});

describe("applyOutcome — refine", () => {
  it("clears the assignee after a successful refine", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({ readyForImplementation: false }),
    });
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("creates the sub-issues for an estimate of 5", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({
        estimate: 5,
        readyForImplementation: false,
        subIssues: [
          { title: "Part 1", type: "type:feature", description: "Do part 1.", estimate: 2, acceptanceCriteria: ["Part 1 works"] },
          { title: "Part 2", type: "type:chore", description: "Do part 2.", estimate: 3, acceptanceCriteria: ["Part 2 works"] },
        ],
      }),
    });
    expect(linear.createIssueCalls.length).toBe(2);
    expect(linear.createIssueCalls.map((call) => call.title)).toEqual(["Part 1", "Part 2"]);
  });

  it("issues zero createIssue calls when the parent already carries children with matching titles", async () => {
    const issue = makeIssue({
      children: [
        { id: "created-1", identifier: "ENG-created-1", title: "Part 1", state: { id: "state-todo", name: "Todo", type: "unstarted" } },
        { id: "created-2", identifier: "ENG-created-2", title: "Part 2", state: { id: "state-todo", name: "Todo", type: "unstarted" } },
      ],
    });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({
        estimate: 5,
        readyForImplementation: false,
        subIssues: [
          { title: "Part 1", type: "type:feature", description: "Do part 1.", estimate: 2, acceptanceCriteria: ["Part 1 works"] },
          { title: "Part 2", type: "type:chore", description: "Do part 2.", estimate: 3, acceptanceCriteria: ["Part 2 works"] },
        ],
      }),
    });
    expect(linear.createIssueCalls.length).toBe(0);
  });
});

describe("applyBlock — dependency (Case A)", () => {
  it("creates the relation, moves to Ready, and releases with no operator assignment", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const blocker = makeIssue({ id: "issue-2", identifier: "ENG-2" });
    const linear = new FakeLinear([issue, blocker]);
    await applyBlock(
      makeDeps(linear, undefined, "operator-1"),
      "ENG-1",
      makeBlockRecord({ type: "dependency", blockedByIssues: ["ENG-2"] }),
      "foreman-implement",
    );

    expect(linear.relationCalls).toEqual([{ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" }]);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_READY.id)).toBe(true);
    // Case A needs no human — the relation is the state, so releaseLock's
    // default clears the assignee even with an operator configured.
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });
});

describe("applyBlock — needs-decision (Case B), refine stage", () => {
  it("moves the issue to Needs Input and releases the lock unassigned when no operator is configured", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "needs-decision" }), "foreman-refine");

    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_NEEDS_INPUT.id)).toBe(true);
    // No operator configured: releases to unassigned.
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("assigns the issue to the configured operator instead of clearing it", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear, undefined, "operator-1"), "ENG-1", makeBlockRecord({ type: "needs-decision" }), "foreman-refine");

    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === "operator-1")).toBe(true);
  });
});

describe("applyBlock — needs-decision (Case B), implementation stage", () => {
  it("moves an implement-stage block to Blocked, not Needs Input", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "needs-decision" }), "foreman-implement");

    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_BLOCKED.id)).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_NEEDS_INPUT.id)).toBe(false);
  });

  it("moves a review-stage block to Blocked, not Needs Input", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "needs-decision" }), "foreman-review");

    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_BLOCKED.id)).toBe(true);
  });
});


describe("applyOutcome — implement", () => {
  it("files each discoveredWork item", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-implement",
      result: {
        issueId: "ENG-1",
        branch: "eng-1-do-the-thing",
        prUrl: "https://github.com/org/repo/pull/1",
        headSha: "abc123",
        criteriaMet: [],
        testsAdded: [],
        discoveredWork: [
          { title: "Found bug", description: "Noticed this.", type: TYPE_LABEL.bug, relation: "related" },
          { title: "Blocking gap", description: "Must fix first.", type: TYPE_LABEL.bug, relation: "blocks" },
        ],
        contextContradictions: [],
        approachSummary: "Did the thing.",
      },
    });
    expect(linear.createIssueCalls.length).toBe(2);
    expect(linear.relationCalls.length).toBe(2);
  });
});

describe("applyOutcome — implement is re-entrant", () => {
  it("creates the discovered issue once across two applies of the same result", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const result = {
      issueId: "ENG-1",
      branch: "eng-1-do-the-thing",
      prUrl: "https://github.com/org/repo/pull/1",
      headSha: "abc123",
      criteriaMet: [],
      testsAdded: [],
      discoveredWork: [
        { title: "Found bug", description: "Noticed this.", type: TYPE_LABEL.bug, relation: "related" as const },
      ],
      contextContradictions: [],
      approachSummary: "Did the thing.",
    };
    await applyOutcome(makeDeps(linear), { kind: "result", agent: "foreman-implement", result });
    expect(linear.createIssueCalls.length).toBe(1);

    // Simulates the retry's fresh fetch: a redelivery re-runs `applyImplement`
    // from the top (`handleCaptured` un-marks the dispatch on failure), and
    // the relation created by the first pass is now visible on the issue.
    issue.relations = [
      {
        id: "relation-1",
        type: "related",
        direction: "outgoing",
        other: {
          id: "created-1",
          identifier: "ENG-created-1",
          title: "Found bug",
          state: { id: "state-backlog", name: "Backlog", type: "backlog" },
        },
      },
    ];

    await applyOutcome(makeDeps(linear), { kind: "result", agent: "foreman-implement", result });
    expect(linear.createIssueCalls.length).toBe(1);
  });
});

describe("applyOutcome — review", () => {
  it("writes a review marker with matching reviewedSha, does not move the issue, and releases the lock for a clean result", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-review",
      result: makeReviewResult({ reviewedSha: "sha-clean" }),
    });

    expect(linear.commentCalls.length).toBe(1);
    const decoded = decodeMarker<ReviewResult>(MARKER_KIND.review, linear.commentCalls[0]?.body ?? "");
    expect(decoded?.reviewedSha).toBe("sha-clean");
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(false);
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("moves the issue to Ready and releases the lock when a finding is blocking", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-review",
      result: makeReviewResult({
        reviewedSha: "sha-blocking",
        verdict: "request-changes",
        findings: [{ severity: "blocking", file: "src/foo.ts", line: 12, description: "Broken." }],
      }),
    });

    expect(linear.commentCalls.length).toBe(1);
    const decoded = decodeMarker<ReviewResult>(MARKER_KIND.review, linear.commentCalls[0]?.body ?? "");
    expect(decoded?.reviewedSha).toBe("sha-blocking");
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_READY.id)).toBe(true);
  });
});

describe("applyOutcome — review, GitHub submission", () => {
  function stubRunner(respond: (argv: string[]) => { stdout: string; code?: number }) {
    const calls: Array<{ argv: string[] }> = [];
    const runner = {
      run(argv: string[], _options: { cwd: string; env?: Record<string, string> }) {
        calls.push({ argv });
        const result = respond(argv);
        return Promise.resolve({ stdout: result.stdout, stderr: "", code: result.code ?? 0 });
      },
    };
    return { runner, calls };
  }

  function makeDepsWithGithub(linear: FakeLinear, runner: { run: (argv: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<{ stdout: string; stderr: string; code: number }> }): ApplyDeps {
    return {
      linear,
      github: new GitHubClient({ runner }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      entry: TEST_ENTRY,
      operatorUserId: null,
    };
  }

  it("submits an APPROVE review to the open PR for a clean verdict", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const { runner, calls } = stubRunner((argv) => {
      if (argv[1] === "pr" && argv[2] === "list") {
        return { stdout: JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7", headRefOid: "sha1", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" }]) };
      }
      return { stdout: "" };
    });
    await applyOutcome(makeDepsWithGithub(linear, runner), {
      kind: "result",
      agent: "foreman-review",
      result: makeReviewResult({ verdict: "approve" }),
    });

    const reviewCall = calls.find((call) => call.argv.some((arg) => arg.includes("reviews")));
    expect(reviewCall?.argv).toContain("event=APPROVE");
  });

  it("maps a request-changes verdict to a REQUEST_CHANGES review event", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const { runner, calls } = stubRunner((argv) => {
      if (argv[1] === "pr" && argv[2] === "list") {
        return { stdout: JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7", headRefOid: "sha1", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" }]) };
      }
      return { stdout: "" };
    });
    await applyOutcome(makeDepsWithGithub(linear, runner), {
      kind: "result",
      agent: "foreman-review",
      result: makeReviewResult({
        verdict: "request-changes",
        findings: [{ severity: "blocking", file: "src/foo.ts", line: 1, description: "Broken." }],
      }),
    });

    const reviewCall = calls.find((call) => call.argv.some((arg) => arg.includes("reviews")));
    expect(reviewCall?.argv).toContain("event=REQUEST_CHANGES");
  });

  it("skips the GitHub mirror entirely when deps.entry has no repoPath/branchPattern", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-review",
      result: makeReviewResult({ verdict: "approve" }),
    });
    // No GitHubClient runner was even wired in makeDeps for this path — the
    // absence of a throw is itself the assertion.
    expect(linear.commentCalls).toHaveLength(1);
  });

  it("skips silently and notifies a warning when no open PR matches the branch, rather than throwing", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const { runner } = stubRunner(() => ({ stdout: "" }));
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      makeDepsWithGithub(linear, runner),
      { kind: "result", agent: "foreman-review", result: makeReviewResult({ verdict: "approve" }) },
      (message, level) => notices.push({ message, level }),
    );
    expect(notices).toEqual([]);
    expect(linear.commentCalls).toHaveLength(1);
  });

  it("notifies a warning rather than throwing when the gh call itself fails", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const runner = {
      run(argv: string[]) {
        if (argv[1] === "pr" && argv[2] === "list") {
          return Promise.resolve({ stdout: JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7", headRefOid: "sha1", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" }]), stderr: "", code: 0 });
        }
        return Promise.reject(new Error("gh: rate limited"));
      },
    };
    const notices: Array<{ message: string; level: string }> = [];
    const facts = await applyOutcome(
      makeDepsWithGithub(linear, runner),
      { kind: "result", agent: "foreman-review", result: makeReviewResult({ verdict: "approve" }) },
      (message, level) => notices.push({ message, level }),
    );
    expect(facts.subject).toBe(issue.identifier);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain("Couldn't submit the GitHub review");
    expect(notices[0]?.level).toBe("warn");
  });
});

function makePlanResult(overrides: Partial<PlanResult> = {}): PlanResult {
  return {
    projectId: "project-1",
    proposedIssues: [
      {
        key: "search-index",
        app: null,
        title: "Wire the search index",
        type: TYPE_LABEL.feature,
        description: "## Context\nBuild the index.",
        acceptanceCriteria: ["Search returns results for a known query"],
        proposedPriority: PRIORITY.Medium,
        proposedEstimate: 2,
        blockedBy: [],
      },
    ],
    outOfScope: ["Ranking tuning"],
    fullyPlanned: false,
    rationale: "One slice covers the brief's first milestone.",
    ...overrides,
  };
}

describe("applyOutcome — plan", () => {
  it("creates one Backlog issue per proposedIssue, tagged with its type label", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult(),
    });

    expect(linear.createIssueCalls).toHaveLength(1);
    const call = linear.createIssueCalls[0];
    expect(call?.title).toBe("Wire the search index");
    expect(call?.teamId).toBe("team-1");
    expect(call?.projectId).toBe("project-1");
    expect(call?.priority).toBe(PRIORITY.Medium);
    expect(call?.estimate).toBe(2);
    const typeLabel = [...linear.labelsById.values()].find((entry) => call?.labelIds?.includes(entry.id));
    expect(typeLabel?.name).toBe(TYPE_LABEL.feature);
    expect(linear.updateProjectStatusCalls).toEqual([{ projectId: "project-1", type: "planned" }]);
    expect(linear.relationCalls).toHaveLength(0);
  });

  it("creates one native `blocks` relation per blockedBy edge, blocker as issueId", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({
        proposedIssues: [
          {
            key: "schema",
            title: "Define schema",
            type: TYPE_LABEL.feature,
            app: null,
            description: "## Context\nSchema.",
            acceptanceCriteria: ["Schema exists"],
            proposedPriority: PRIORITY.Medium,
            proposedEstimate: 1,
            blockedBy: [],
          },
          {
            key: "api",
            title: "Build the API",
            type: TYPE_LABEL.feature,
            app: null,
            description: "## Context\nAPI.",
            acceptanceCriteria: ["API responds"],
            proposedPriority: PRIORITY.Medium,
            proposedEstimate: 2,
            blockedBy: ["schema"],
          },
          {
            key: "ui",
            title: "Build the UI",
            type: TYPE_LABEL.feature,
            app: null,
            description: "## Context\nUI.",
            acceptanceCriteria: ["UI renders"],
            proposedPriority: PRIORITY.Medium,
            proposedEstimate: 2,
            blockedBy: ["schema", "api"],
          },
        ],
      }),
    });

    expect(linear.createIssueCalls).toHaveLength(3);
    expect(linear.relationCalls).toHaveLength(3);
    const schemaId = "created-1";
    const apiId = "created-2";
    const uiId = "created-3";
    expect(linear.relationCalls).toEqual(
      expect.arrayContaining([
        { issueId: schemaId, relatedIssueId: apiId, type: "blocks" },
        { issueId: schemaId, relatedIssueId: uiId, type: "blocks" },
        { issueId: apiId, relatedIssueId: uiId, type: "blocks" },
      ]),
    );
  });

  it("leaves the project status untouched when proposedIssues is empty", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [], fullyPlanned: true }),
    });
    expect(linear.updateProjectStatusCalls).toEqual([]);
  });

  it("creates nothing when proposedIssues is empty", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [], fullyPlanned: true }),
    });
    expect(linear.createIssueCalls).toHaveLength(0);
  });

  it("throws when the project no longer exists", async () => {
    const linear = new FakeLinear([]);
    await expect(
      applyOutcome(makeDeps(linear, TEST_ENTRY), { kind: "result", agent: "foreman-plan", result: makePlanResult() }),
    ).rejects.toThrow("unknown project");
  });

  it("throws and records a failure when the project belongs to another team", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    // The entry is bound to team ENG; `projects("ENG")` never lists this
    // project, so it belongs to some other team.
    linear.projectsList = [];
    await expect(
      applyOutcome(makeDeps(linear, TEST_ENTRY), { kind: "result", agent: "foreman-plan", result: makePlanResult() }),
    ).rejects.toThrow("not on team ENG");
    expect(linear.createIssueCalls).toHaveLength(0);
  });

  it("resolves a proposedIssue's app to an existing workspace label id", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    linear.labelsById.set("label-app-fleet", { id: "label-app-fleet", name: "app:fleet", parentId: null });
    await applyOutcome(makeDeps(linear, TEST_ENTRY), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [{ ...makePlanResult().proposedIssues[0]!, app: "fleet" }] }),
    });

    const call = linear.createIssueCalls[0];
    expect(call?.labelIds).toContain("label-app-fleet");
  });

  it("reports an unknown app as a non-fatal problem and still creates the issue", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = {
      id: "project-1",
      name: "Search revamp",
      description: null,
      content: "Brief.",
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    linear.projectsList = [{ id: "project-1", name: "Search revamp" }];
    const notices: Array<{ message: string; level: string }> = [];
    await applyOutcome(
      makeDeps(linear, TEST_ENTRY),
      {
        kind: "result",
        agent: "foreman-plan",
        result: makePlanResult({ proposedIssues: [{ ...makePlanResult().proposedIssues[0]!, app: "ghost" }] }),
      },
      (message, level) => notices.push({ message, level }),
    );

    expect(linear.createIssueCalls).toHaveLength(1);
    expect(notices.some((notice) => notice.message.includes('unknown app "ghost"; applied no app label'))).toBe(true);
  });

  it("a blocked plan outcome with no issueId is a documented no-op, not a throw", async () => {
    const linear = new FakeLinear([]);
    await applyOutcome(makeDeps(linear), { kind: "blocked", agent: "foreman-plan", block: makeBlockRecord(), issueId: "" });
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
  });
});

function makeContextResult(overrides: Partial<ContextResult> = {}): ContextResult {
  return {
    teamId: "team-1",
    decisions: "- Use TypeBox for schemas",
    vocabulary: "- Dispatch: one task-tool call to a foreman-* agent",
    nonGoals: "- No auto-merge",
    removals: [],
    changeSummary: "Recorded the schema decision",
    rationale: "Repeated agent re-derivation of this decision",
    ...overrides,
  };
}

const CONTEXT_DOC_LIVE = [
  "## Architectural decisions and constraints",
  "",
  "- Use TypeBox for schemas",
  "",
  "## Domain vocabulary",
  "",
  "- Dispatch: one task-tool call to a foreman-* agent",
  "",
  "## Known non-goals",
  "",
  "- No auto-merge",
  "",
  "## Definition of Done",
  "",
  "- [ ] Tests written and passing",
  "",
].join("\n");

describe("applyOutcome — context", () => {
  function makeContextDeps(): { linear: FakeLinear; deps: ApplyDeps } {
    const linear = new FakeLinear([]);
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    linear.documentsList = [
      { id: "doc-1", title: "Context", content: CONTEXT_DOC_LIVE, updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    return { linear, deps: makeDeps(linear, TEST_ENTRY) };
  }

  it("writes the merged body and leaves the live Definition of Done byte-identical", async () => {
    const { linear, deps } = makeContextDeps();
    await applyOutcome(deps, {
      kind: "result",
      agent: "foreman-context",
      result: makeContextResult({ decisions: "- Use TypeBox for schemas\n- Never write `: any`" }),
    });

    expect(linear.updateDocumentCalls).toHaveLength(1);
    const written = linear.updateDocumentCalls[0]!.content;
    expect(written).toContain("- Never write `: any`");
    const dodStart = written.indexOf("## Definition of Done");
    expect(written.slice(dodStart)).toBe("## Definition of Done\n\n- [ ] Tests written and passing\n");
  });

  it("throws on an undeclared removal and writes nothing", async () => {
    const { linear, deps } = makeContextDeps();
    await expect(
      applyOutcome(deps, {
        kind: "result",
        agent: "foreman-context",
        result: makeContextResult({ decisions: "" }),
      }),
    ).rejects.toThrow(/declared removal/);
    expect(linear.updateDocumentCalls).toHaveLength(0);
  });

  it("writes nothing and does not throw when the proposal matches the live doc", async () => {
    const { linear, deps } = makeContextDeps();
    await applyOutcome(deps, { kind: "result", agent: "foreman-context", result: makeContextResult() });
    expect(linear.updateDocumentCalls).toHaveLength(0);
  });

  it("throws naming doctor --fix when the Context doc is missing", async () => {
    const linear = new FakeLinear([]);
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    const deps = makeDeps(linear, TEST_ENTRY);
    await expect(
      applyOutcome(deps, { kind: "result", agent: "foreman-context", result: makeContextResult() }),
    ).rejects.toThrow(/doctor --fix/);
  });

  it("refuses a teamId outside the bound team", async () => {
    const { deps } = makeContextDeps();
    await expect(
      applyOutcome(deps, {
        kind: "result",
        agent: "foreman-context",
        result: makeContextResult({ teamId: "team-other" }),
      }),
    ).rejects.toThrow(/team/i);
  });
});
