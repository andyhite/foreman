import { describe, expect, it } from "bun:test";
import { FOREMAN_LABEL, MARKER_KIND, PRIORITY, TYPE_LABEL, decodeMarker } from "@foreman/core";
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
  TriageResult,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { applyBlock, applyOutcome, type ApplyDeps } from "../src/results/apply.ts";

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
    labels: [label(TYPE_LABEL.feature), label(FOREMAN_LABEL.running)],
    state: STATE_TODO,
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
  async projectRelations() {
    return [];
  }
  async createProjectRelation() {}
  async deleteProjectRelation() {}
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

function makeDeps(linear: FakeLinear, entry?: Pick<ResolvedRepoEntry, "team" | "repoPath" | "branchPattern">, operatorUserId: string | null = null): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z"), entry, operatorUserId };
}

function makeTriageItem(overrides: Partial<TriageResult["items"][number]> = {}): TriageResult {
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

  it("cancel: leaves state untouched, applies foreman:blocked, writes a block marker", async () => {
    const issue = makeIssue({ state: { id: "state-triage", name: "Triage", type: "triage", position: 0 } });
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-triage",
      result: makeTriageItem({ destination: "cancel", destinationProjectId: null }),
    });

    expect(linear.commentCalls.length).toBe(1);
    const addedLabelIds = linear.updateCalls.flatMap((call) => call.input.addedLabelIds ?? []);
    const addedNames = addedLabelIds.map((id) => [...linear.labelsById.values()].find((l) => l.id === id)?.name);
    expect(addedNames).toContain(FOREMAN_LABEL.blocked);
    expect(linear.updateCalls.some((call) => call.input.stateId !== undefined)).toBe(false);
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
});

describe("applyOutcome — refine", () => {
  it("removes the foreman:running label and clears the assignee after a successful refine", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    await applyOutcome(makeDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({ readyForImplementation: false }),
    });
    expect(issue.labels.some((l) => l.name === FOREMAN_LABEL.running)).toBe(false);
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
  it("applies no foreman:blocked label but does create the relation, move to Todo, and release with no operator assignment", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const blocker = makeIssue({ id: "issue-2", identifier: "ENG-2" });
    const linear = new FakeLinear([issue, blocker]);
    await applyBlock(makeDeps(linear, undefined, "operator-1"), "ENG-1", makeBlockRecord({ type: "dependency", blockedByIssues: ["ENG-2"] }));

    expect(linear.relationCalls).toEqual([{ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" }]);
    const blockedLabelAdds = linear.updateCalls.filter((call) =>
      call.input.addedLabelIds?.some((id) => [...linear.labelsById.values()].find((l) => l.id === id)?.name === FOREMAN_LABEL.blocked),
    );
    expect(blockedLabelAdds.length).toBe(0);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_TODO.id)).toBe(true);
    // Case A needs no human — the relation is the state, so releaseLock's
    // default clears the assignee even with an operator configured.
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });
});

describe("applyBlock — needs-decision (Case B)", () => {
  it("applies the foreman:blocked label and returns to Todo when the issue was In Progress", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear), "ENG-1", makeBlockRecord({ type: "needs-decision" }));

    const addedLabelIds = linear.updateCalls.flatMap((call) => call.input.addedLabelIds ?? []);
    const addedNames = addedLabelIds.map((id) => [...linear.labelsById.values()].find((l) => l.id === id)?.name);
    expect(addedNames).toContain(FOREMAN_LABEL.blocked);
    expect(linear.updateCalls.some((call) => call.input.stateId === STATE_TODO.id)).toBe(true);
    // No operator configured: releases to unassigned.
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("assigns the issue to the configured operator instead of clearing it", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW });
    const linear = new FakeLinear([issue]);
    await applyBlock(makeDeps(linear, undefined, "operator-1"), "ENG-1", makeBlockRecord({ type: "needs-decision" }));

    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === "operator-1")).toBe(true);
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
    expect(issue.labels.some((l) => l.name === FOREMAN_LABEL.running)).toBe(false);
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
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
    expect(issue.labels.some((l) => l.name === FOREMAN_LABEL.running)).toBe(false);
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
      entry: { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" },
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
      documents: [],
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    await applyOutcome(makeDeps(linear, { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" }), {
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
      documents: [],
      startDate: null,
      targetDate: null,
      status: null,
    };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];
    await applyOutcome(makeDeps(linear, { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" }), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({
        proposedIssues: [
          {
            key: "schema",
            title: "Define schema",
            type: TYPE_LABEL.feature,
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
      documents: [],
      startDate: null,
      targetDate: null,
      status: null,
    };
    await applyOutcome(makeDeps(linear, { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" }), {
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
      documents: [],
      startDate: null,
      targetDate: null,
      status: null,
    };
    await applyOutcome(makeDeps(linear, { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" }), {
      kind: "result",
      agent: "foreman-plan",
      result: makePlanResult({ proposedIssues: [], fullyPlanned: true }),
    });
    expect(linear.createIssueCalls).toHaveLength(0);
  });

  it("throws when the project no longer exists", async () => {
    const linear = new FakeLinear([]);
    await expect(
      applyOutcome(makeDeps(linear, { team: "ENG", repoPath: "/repo", branchPattern: "<issue-id>-<slug>" }), { kind: "result", agent: "foreman-plan", result: makePlanResult() }),
    ).rejects.toThrow("unknown project");
  });

  it("a blocked plan outcome with no issueId is a documented no-op, not a throw", async () => {
    const linear = new FakeLinear([]);
    await applyOutcome(makeDeps(linear), { kind: "blocked", agent: "foreman-plan", block: makeBlockRecord(), issueId: "" });
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
  });
});
