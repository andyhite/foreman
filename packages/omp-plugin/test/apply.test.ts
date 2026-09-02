import { describe, expect, it } from "bun:test";
import { AGENT_LABEL, BLOCKED_LABEL, MARKER_KIND, PRIORITY, TYPE_LABEL, decodeMarker, encodeMarker } from "@foreman/core";
import type {
  BlockRecord,
  Comment,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueRelationType,
  LinearWriter,
  PlanResult,
  Project,
  RefineResult,
  ResolvedRepoEntry,
  ReviewResult,
  TeamRef,
  TriageItem,
  TriageProposal,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { applyBlock, applyOutcome, type ApplyDeps } from "../src/results/apply.ts";
import { runApplyCommand } from "../src/commands/apply.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_REVIEW: WorkflowState = {
  id: "state-in-review",
  name: "In Review",
  type: "started",
  position: 4,
};
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
    labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.running)],
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
  projectRecord: Project | null = null;
  teamsList: TeamRef[] = [];
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  updateProjectStatusCalls: Array<{ projectId: string; type: string }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  createIssueCalls: CreateIssueInput[] = [];
  relationCalls: Array<{ issueId: string; relatedIssueId: string; type: IssueRelationType }> = [];

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
  async projectInitiatives() {
    return [{ id: "initiative-1", name: "Foreman" }];
  }
  async projectInitiative() {
    return { id: "initiative-1", name: "Foreman" };
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
    return [STATE_TODO, STATE_IN_REVIEW, STATE_BACKLOG];
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
      issue.state = [STATE_TODO, STATE_IN_REVIEW, STATE_BACKLOG].find((state) => state.id === input.stateId) ?? issue.state;
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
  async createProject(input: { name: string; teamIds: string[]; description?: string; content?: string }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
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

function makeDeps(linear: FakeLinear, entry?: Pick<ResolvedRepoEntry, "team">): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z"), entry };
}

function makeTriageProposal(overrides: Partial<TriageProposal["items"][number]> = {}): TriageProposal {
  return {
    summary: "One batch.",
    items: [
      {
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
        draftDescription: null,
        proposedEstimate: null,
        destinationProjectId: null,
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
  it("writes one comment per item plus agent:proposed and performs no state change", async () => {
    const issue = makeIssue({ labels: [label(TYPE_LABEL.feature)] });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), { kind: "result", agent: "foreman-triage", result: makeTriageProposal() });

    expect(linear.commentCalls.length).toBe(1);
    const proposedAdds = linear.updateCalls.filter((call) => call.input.addedLabelIds !== undefined);
    expect(proposedAdds.length).toBe(1);
    const addedLabel = [...linear.labelsById.values()].find((entry) => entry.id === proposedAdds[0]?.input.addedLabelIds?.[0]);
    expect(addedLabel?.name).toBe(AGENT_LABEL.proposed);
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(false);
  });
});

describe("applyOutcome — refine", () => {
  it("does not apply agent:ready when readyForImplementation is false", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({ readyForImplementation: false }),
    });
    const readyLabel = [...linear.labelsById.values()].find((entry) => entry.name === AGENT_LABEL.ready);
    expect(readyLabel).toBeUndefined();
  });

  it("removes the agent:running label after a successful refine", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({ readyForImplementation: false }),
    });
    expect(issue.labels.some((l) => l.name === AGENT_LABEL.running)).toBe(false);
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
  it("applies no blocked:* label but does create the relation and move to Todo", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const blocker = makeIssue({ id: "issue-2", identifier: "ENG-2" });
    const linear = new FakeLinear([issue, blocker]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "dependency", blockedByIssues: ["ENG-2"] }));

    expect(linear.relationCalls).toEqual([{ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" }]);
    const blockedLabelAdds = linear.updateCalls.filter((call) =>
      call.input.addedLabelIds?.some((id) => [...linear.labelsById.values()].find((l) => l.id === id)?.name.startsWith("blocked:")),
    );
    expect(blockedLabelAdds.length).toBe(0);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_TODO.id)).toBe(true);
  });
});

describe("applyBlock — needs-decision (Case B)", () => {
  it("applies the blocked:needs-decision label", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "needs-decision" }));

    const addedLabelIds = linear.updateCalls.flatMap((call) => call.input.addedLabelIds ?? []);
    const addedNames = addedLabelIds.map((id) => [...linear.labelsById.values()].find((l) => l.id === id)?.name);
    expect(addedNames).toContain(BLOCKED_LABEL.needsDecision);
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
        approachSummary: "Did the thing.",
      },
    });
    expect(linear.createIssueCalls.length).toBe(2);
    expect(linear.relationCalls.length).toBe(2);
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
    expect(issue.labels.some((l) => l.name === AGENT_LABEL.running)).toBe(false);
  });

  it("moves the issue to Todo and releases the lock when a finding is blocking", async () => {
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
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_TODO.id)).toBe(true);
    expect(issue.labels.some((l) => l.name === AGENT_LABEL.running)).toBe(false);
  });
});

function makePlanResult(overrides: Partial<PlanResult> = {}): PlanResult {
  return {
    projectId: "project-1",
    proposedIssues: [
      {
        title: "Wire the search index",
        type: TYPE_LABEL.feature,
        description: "## Context\nBuild the index.",
        acceptanceCriteria: ["Search returns results for a known query"],
        proposedPriority: PRIORITY.Medium,
        proposedEstimate: 2,
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
    linear.projectRecord = { id: "project-1", name: "Search revamp", description: null, content: "Brief.", documents: [] };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    await applyOutcome(makeDeps(linear, { team: "ENG" }), {
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
  });

  it("leaves the project status untouched when proposedIssues is empty", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = { id: "project-1", name: "Search revamp", description: null, content: "Brief.", documents: [] };
    await applyOutcome(makeDeps(linear, { team: "ENG" }), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [], fullyPlanned: true }),
    });
    expect(linear.updateProjectStatusCalls).toEqual([]);
  });

  it("creates nothing when proposedIssues is empty", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = { id: "project-1", name: "Search revamp", description: null, content: "Brief.", documents: [] };
    await applyOutcome(makeDeps(linear, { team: "ENG" }), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [], fullyPlanned: true }),
    });
    expect(linear.createIssueCalls).toHaveLength(0);
  });

  it("throws when the project no longer exists", async () => {
    const linear = new FakeLinear([]);
    await expect(
      applyOutcome(makeDeps(linear, { team: "ENG" }), { kind: "result", agent: "foreman-plan", result: makePlanResult() }),
    ).rejects.toThrow("unknown project");
  });

  it("a blocked plan outcome with no issueId is a documented no-op, not a throw", async () => {
    const linear = new FakeLinear([]);
    await applyOutcome(makeDeps(linear), { kind: "blocked", agent: "foreman-plan", block: makeBlockRecord(), issueId: "" });
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
  });
});

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
    draftDescription: null,
    proposedEstimate: null,
    destinationProjectId: null,
    ...overrides,
  };
}

function proposalComment(item: TriageItem, createdAt: string): Comment {
  return { id: `comment-proposal-${createdAt}`, body: encodeMarker(MARKER_KIND.proposal, item, "human text"), createdAt, user: { id: "bot-1", name: "Foreman", displayName: "Foreman" }, parentId: null };
}

describe("runApplyCommand — --approve", () => {
  it("refuses when the issue has no proposal marker", async () => {
    const issue = makeIssue({ comments: [] });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("no proposal marker");
  });

  it("refuses when the issue already has a later applied marker", async () => {
    const item = makeTriageItem();
    const proposedAt = "2026-01-01T00:00:00.000Z";
    const appliedAt = "2026-01-02T00:00:00.000Z";
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature)],
      comments: [
        proposalComment(item, proposedAt),
        { id: "comment-applied", body: encodeMarker(MARKER_KIND.applied, { issueId: "ENG-1", appliedProposalAt: proposedAt }, "applied"), createdAt: appliedAt, user: { id: "bot-1", name: "Foreman", displayName: "Foreman" }, parentId: null },
      ],
    });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("already");
  });

  it("keeps agent:proposed when applyProposal throws", async () => {
    const item = makeTriageItem({ destinationProject: "Missing Project" });
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.proposed)],
      comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(false);
    expect(issue.labels.some((entry) => entry.name === AGENT_LABEL.proposed)).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.removedLabelIds !== undefined)).toBe(false);
  });

  it("resolves destinationProject to a project id, matching case-insensitively", async () => {
    const item = makeTriageItem({ destinationProject: "roadmap" });
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature)],
      comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(true);
    const mutation = linear.updateCalls.find((call) => call.input.projectId !== undefined);
    expect(mutation?.input.projectId).toBe("project-roadmap");
  });

  it("fails without mutating when destinationProject names no project", async () => {
    const item = makeTriageItem({ destinationProject: "Nonexistent Project" });
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature)],
      comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(false);
    expect(linear.updateCalls.some((call) => call.input.projectId !== undefined)).toBe(false);
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("runApplyCommand — --reject", () => {
  it("refuses an empty reason", async () => {
    const issue = makeIssue({ comments: [proposalComment(makeTriageItem(), "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, ["ENG-1", "--reject"]);
    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
  });

  it("does not remove agent:proposed", async () => {
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.proposed)],
      comments: [proposalComment(makeTriageItem(), "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, ["ENG-1", "--reject", "not", "worth", "it"]);
    expect(result.ok).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.removedLabelIds !== undefined)).toBe(false);
    expect(issue.labels.some((entry) => entry.name === AGENT_LABEL.proposed)).toBe(true);
  });
});

describe("runApplyCommand — bare bulk", () => {
  it("mutates nothing", async () => {
    const item = makeTriageItem();
    const issue = makeIssue({ comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, []);
    expect(result.mutated).toBe(false);
    expect(linear.updateCalls.length).toBe(0);
    expect(linear.commentCalls.length).toBe(0);
  });
});

describe("runApplyCommand — --yes", () => {
  it("reports per-issue failures without stopping the pass, including a not-found destinationProject", async () => {
    const first = makeIssue({
      comments: [proposalComment(makeTriageItem({ destinationProject: "Missing Project" }), "2026-01-01T00:00:00.000Z")],
    });
    const second = makeIssue({
      id: "issue-2",
      identifier: "ENG-2",
      comments: [proposalComment(makeTriageItem({ issueId: "ENG-2" }), "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([first, second]);
    const updateIssue = linear.updateIssue.bind(linear);
    linear.updateIssue = async (id, input) => {
      if (id === second.id) throw new Error("Linear unavailable");
      return updateIssue(id, input);
    };

    const result = await runApplyCommand(linear, ["--yes"]);

    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("Applied 0 approved proposal(s).");
    expect(result.message).toContain("Missing Project");
    expect(result.message).toContain("ENG-2: failed to apply: Linear unavailable");
  });
});

describe("runApplyCommand — --yes scope partition", () => {
  it("applies only the in-scope candidate and reports the out-of-scope one as skipped", async () => {
    const inScope = makeIssue({
      comments: [proposalComment(makeTriageItem(), "2026-01-01T00:00:00.000Z")],
    });
    const outOfScope = makeIssue({
      id: "issue-2",
      identifier: "ENG-2",
      project: null,
      comments: [proposalComment(makeTriageItem({ issueId: "ENG-2" }), "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([inScope, outOfScope]);
    const entry: ResolvedRepoEntry = {
      alias: "test",
      repoPath: "/repo",
      team: "ENG",
      initiativeIds: ["initiative-1"],
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: false },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    };

    const result = await runApplyCommand(linear, ["--yes"], entry);

    expect(result.mutated).toBe(true);
    expect(result.message).toContain("Applied 1 approved proposal(s).");
    expect(result.message).toContain("1 skipped: not bound to this repo's initiatives.");
    expect(linear.updateCalls.some((call) => call.id === inScope.id)).toBe(true);
    expect(linear.updateCalls.some((call) => call.id === outOfScope.id)).toBe(false);
  });
});
