import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_LABEL, BLOCKED_LABEL, PRIORITY, TYPE_LABEL } from "@foreman/core";
import type {
  BlockRecord,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueRelationType,
  LinearWriter,
  RefineResult,
  TeamRef,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { applyBoundResult, blockedOutcome, handleCaptured, __resetAppliedDispatchIdsForTest } from "../src/extension.ts";
import type { ApplyDeps, AgentOutcome } from "../src/results/apply.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_PROGRESS: WorkflowState = { id: "state-in-progress", name: "In Progress", type: "started", position: 3 };

afterEach(() => {
  __resetAppliedDispatchIdsForTest();
});

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

/** Minimal `LinearWriter` fake covering only what `applyBoundResult`/`applyBlock` touch. */
class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  labelsById = new Map<string, IssueLabel>();
  teamsList: TeamRef[] = [];
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
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
  async viewerId(): Promise<string> {
    return "bot-1";
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
    return [STATE_TODO, STATE_IN_PROGRESS];
  }
  async labels(): Promise<IssueLabel[]> {
    return [...this.labelsById.values()];
  }
  async teams() {
    return this.teamsList;
  }
  async projects() {
    return [];
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
      issue.state = [STATE_TODO, STATE_IN_PROGRESS].find((state) => state.id === input.stateId) ?? issue.state;
    }
    return issue;
  }
  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const created = makeIssue({ id: `created-1`, identifier: `ENG-created-1`, title: input.title });
    this.issuesById.set(created.identifier, created);
    return created;
  }
  async createProject(input: { name: string; teamIds: string[] }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
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

function makeDeps(linear: FakeLinear): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z") };
}

function makeBlockRecord(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blocked: true,
    type: "needs-input",
    whatIWasDoing: "Implementing.",
    whatINeed: "Clarification.",
    options: null,
    recommendation: null,
    stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "" },
    costOfWrongGuess: "Low.",
    blockedByIssues: [],
    ...overrides,
  } as BlockRecord;
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

describe("blockedOutcome — human block targets the locked issue", () => {
  it("resolves issueId from the dispatch's locked target, not blockedByIssues[0] (previously always empty)", async () => {
    const issue = makeIssue({ id: "issue-1", identifier: "ENG-1" });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);

    // A human block (`needs-input`) never carries `blockedByIssues` — that
    // field is populated only for `type: "dependency"` (SPEC / envelope
    // invariant). Before the fix, `blockedOutcome` read
    // `block.blockedByIssues[0] ?? ""`, which always resolved to "" for this
    // shape, so `applyOutcome` no-op'd and the operator never saw the block.
    const block = makeBlockRecord({ type: "needs-input", blockedByIssues: [] });
    const outcome = blockedOutcome("foreman-implement", block, "ENG-1");
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("unreachable");
    expect(outcome.issueId).toBe("ENG-1");

    await applyBoundResult(deps, "foreman-implement", outcome, "ENG-1", "foreman-implement-ENG-1-20260101T000000Z-abc123", () => {});

    const updatedIssue = await linear.issue("ENG-1");
    expect(updatedIssue?.labels.some((entry) => entry.name === BLOCKED_LABEL.needsInput)).toBe(true);
    // One comment for the block itself, one for the applied-dispatch marker.
    expect(linear.commentCalls.length).toBe(2);
    // The lock is released as part of the human-block path.
    expect(updatedIssue?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
  });
});

describe("applyBoundResult — rejects a result naming a different issue than the dispatch locked", () => {
  it("does not mutate either issue, comments on the locked issue, and releases its lock", async () => {
    const lockedIssue = makeIssue({ id: "issue-1", identifier: "ENG-1", labels: [label(AGENT_LABEL.running)] });
    const otherIssue = makeIssue({ id: "issue-2", identifier: "ENG-9", title: "Someone else's issue", labels: [] });
    const linear = new FakeLinear([lockedIssue, otherIssue]);
    const deps = makeDeps(linear);

    const notifications: Array<{ message: string; level: string }> = [];
    const result = makeRefineResult({ issueId: "ENG-9" });
    const outcome: AgentOutcome = { kind: "result", agent: "foreman-refine", result };

    await applyBoundResult(
      deps,
      "foreman-refine",
      outcome,
      "ENG-1",
      "foreman-refine-ENG-1-20260101T000000Z-abc123",
      (message, level) => notifications.push({ message, level }),
    );

    // Neither issue was mutated by the (rejected) refine result itself:
    // no state change, no description/estimate update, no sub-issues.
    const updatedOther = await linear.issue("ENG-9");
    expect(updatedOther?.description).toBe(otherIssue.description);
    expect(updatedOther?.labels).toEqual(otherIssue.labels);

    // The locked issue's `agent:running` label was removed (lock released)
    // and it received the rejection comment; nothing else changed.
    const updatedLocked = await linear.issue("ENG-1");
    expect(updatedLocked?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
    expect(linear.commentCalls).toEqual([
      {
        issueId: "ENG-1",
        body: "Foreman rejected this dispatch result: it reported issue ENG-9, but this dispatch locked ENG-1.",
      },
    ]);
    expect(notifications).toEqual([
      {
        message: "Foreman rejected foreman-refine's result: it reported issue ENG-9, but this dispatch locked ENG-1.",
        level: "error",
      },
    ]);
  });

  it("applies normally when the result's issueId matches the locked target", async () => {
    const issue = makeIssue({ id: "issue-1", identifier: "ENG-1" });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);

    const result = makeRefineResult({ issueId: "ENG-1", readyForImplementation: false });
    const outcome: AgentOutcome = { kind: "result", agent: "foreman-refine", result };

    await applyBoundResult(deps, "foreman-refine", outcome, "ENG-1", "foreman-refine-ENG-1-20260101T000000Z-abc123", () => {});

    const updated = await linear.issue("ENG-1");
    expect(updated?.labels.some((entry) => entry.name === "agent:running")).toBe(false);
    expect(linear.updateCalls[0]?.input.description).toContain("Body.");
    // `markApplied` writes the dispatch-applied marker comment.
    expect(linear.commentCalls.length).toBe(1);
  });
});

describe("handleCaptured — an invalid result restores the issue's pre-dispatch state", () => {
  it("moves an implement dispatch's issue back to Todo instead of stranding it In Progress", async () => {
    const issue = makeIssue({
      id: "issue-1",
      identifier: "ENG-1",
      state: STATE_IN_PROGRESS,
      labels: [label(AGENT_LABEL.running)],
    });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);
    const notifications: Array<{ message: string; level: string }> = [];

    // `{ garbage: true }` fails the foreman-implement envelope schema, so
    // `parseAgentOutput` reports `kind: "invalid"`; `aborted: false` rules
    // out the budget-truncation branch.
    await handleCaptured(
      "foreman-implement-ENG-1-20260101T000000Z-abc123",
      "foreman-implement",
      { garbage: true },
      false,
      "ENG-1",
      STATE_TODO.id,
      (message, level) => notifications.push({ message, level }),
      deps,
    );

    const updated = await linear.issue("ENG-1");
    expect(updated?.state.id).toBe(STATE_TODO.id);
    expect(updated?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
    expect(notifications).toEqual([
      { message: expect.stringContaining("Foreman rejected foreman-implement's invalid result"), level: "error" },
    ]);
  });

  it("leaves state untouched for a refine dispatch, which never moves state (previousStateId null is a no-op)", async () => {
    const issue = makeIssue({ id: "issue-1", identifier: "ENG-1", state: STATE_TODO, labels: [label(AGENT_LABEL.running)] });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);

    await handleCaptured(
      "foreman-refine-ENG-1-20260101T000000Z-abc123",
      "foreman-refine",
      { garbage: true },
      false,
      "ENG-1",
      null,
      () => {},
      deps,
    );

    const updated = await linear.issue("ENG-1");
    expect(updated?.state.id).toBe(STATE_TODO.id);
    expect(updated?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
  });
});

describe("handleCaptured — appliedDispatchIds is not poisoned by a throwing apply", () => {
  it("a retry after a transient failure can still apply", async () => {
    const issue = makeIssue({
      id: "issue-1",
      identifier: "ENG-1",
      state: STATE_IN_PROGRESS,
      labels: [label(AGENT_LABEL.running)],
    });
    const linear = new FakeLinear([issue]);
    let commentCallCount = 0;
    // Wraps the fake, rather than mutating its method, so the failure is
    // scoped to this test's `deps.linear` reference only.
    const flakyLinear: LinearWriter = new Proxy(linear, {
      get(target, prop, receiver) {
        if (prop === "createComment") {
          return async (input: { issueId: string; body: string; parentId?: string }) => {
            commentCallCount += 1;
            if (commentCallCount === 1) throw new Error("transient Linear failure");
            return target.createComment(input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const deps: ApplyDeps = { linear: flakyLinear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z") };
    const dispatchId = "foreman-implement-ENG-1-20260101T000000Z-abc123";

    await expect(
      handleCaptured(dispatchId, "foreman-implement", { garbage: true }, false, "ENG-1", STATE_TODO.id, () => {}, deps),
    ).rejects.toThrow("transient Linear failure");

    // Before the fix, `appliedDispatchIds.add(dispatchId)` ran before this
    // handling could throw, so the retry below would have been silently
    // dropped as "already applied" with no durable marker ever written.
    await handleCaptured(dispatchId, "foreman-implement", { garbage: true }, false, "ENG-1", STATE_TODO.id, () => {}, deps);

    const updated = await linear.issue("ENG-1");
    expect(updated?.state.id).toBe(STATE_TODO.id);
    expect(commentCallCount).toBe(2);
  });
});
