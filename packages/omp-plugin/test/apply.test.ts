import { describe, expect, it } from "bun:test";
import { AGENT_LABEL, BLOCKED_LABEL, MARKER_KIND, PRIORITY, TYPE_LABEL, encodeMarker } from "@foreman/core";
import type {
  BlockRecord,
  Comment,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueRelationType,
  LinearWriter,
  RefineResult,
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
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
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
  async issues(): Promise<Issue[]> {
    return [...this.issuesById.values()];
  }
  async comments() {
    return [];
  }
  async project() {
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
  async workflowStates(): Promise<WorkflowState[]> {
    return [STATE_TODO, STATE_IN_REVIEW, STATE_BACKLOG];
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

function makeDeps(linear: FakeLinear): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z") };
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
          { title: "Part 1", description: "Do part 1.", estimate: 2, acceptanceCriteria: ["Part 1 works"] },
          { title: "Part 2", description: "Do part 2.", estimate: 3, acceptanceCriteria: ["Part 2 works"] },
        ],
      }),
    });
    expect(linear.createIssueCalls.length).toBe(2);
    expect(linear.createIssueCalls.map((call) => call.title)).toEqual(["Part 1", "Part 2"]);
  });
});

describe("applyBlock — dependency (Case A)", () => {
  it("applies no blocked:* label but does create the relation and move to Todo", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const blocker = makeIssue({ id: "issue-2", identifier: "ENG-2" });
    const linear = new FakeLinear([issue, blocker]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "dependency", blockedByIssues: ["ENG-2"] }));

    expect(linear.relationCalls).toEqual([{ issueId: issue.id, relatedIssueId: blocker.id, type: "blocks" }]);
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
        { id: "comment-applied", body: encodeMarker(MARKER_KIND.applied, { issueId: "ENG-1" }, "applied"), createdAt: appliedAt, user: null, parentId: null },
      ],
    });
    const linear = new FakeLinear([issue]);
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(false);
    expect(result.mutated).toBe(false);
    expect(result.message).toContain("already");
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

  it("applies everything else and notes an unmatched destinationProject without dropping the rest", async () => {
    const item = makeTriageItem({ destinationProject: "Nonexistent Project" });
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature)],
      comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")],
    });
    const linear = new FakeLinear([issue]);
    linear.projectsList = [{ id: "project-roadmap", name: "Roadmap" }];
    const result = await runApplyCommand(linear, ["ENG-1", "--approve"]);
    expect(result.ok).toBe(true);
    expect(linear.updateCalls.some((call) => call.input.projectId !== undefined)).toBe(false);
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(true);
    const appliedComment = linear.commentCalls.find((call) => call.body.includes("Nonexistent Project"));
    expect(appliedComment?.body).toContain("not found");
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
