import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_LABEL, BLOCKED_LABEL, PRIORITY, TYPE_LABEL, acceptanceCriteria, openQuestions } from "@foreman/core";
import type {
  AgentReport,
  BlockRecord,
  CreateIssueInput,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueRelationType,
  LinearWriter,
  Project,
  RefineResult,
  TeamRef,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { applyBoundResult, blockedOutcome, handleCaptured, __resetAppliedDispatchIdsForTest, __resetInFlightCapturesForTest } from "../src/extension.ts";
import type { ApplyDeps, AgentOutcome } from "../src/results/apply.ts";
import { extractFromToolResult } from "../src/results/sink.ts";

const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: "Backlog", type: "backlog", position: 1 };
const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_PROGRESS: WorkflowState = { id: "state-in-progress", name: "In Progress", type: "started", position: 3 };

afterEach(() => {
  __resetAppliedDispatchIdsForTest();
  __resetInFlightCapturesForTest();
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
  createIssueCalls: CreateIssueInput[] = [];
  projectStatusCalls: Array<{ projectId: string; type: string }> = [];
  projectRecord: Project | null = null;

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
    return this.projectRecord;
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
    return [STATE_BACKLOG, STATE_TODO, STATE_IN_PROGRESS];
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
    this.createIssueCalls.push(input);
    const ordinal = this.createIssueCalls.length;
    const created = makeIssue({ id: `created-${ordinal}`, identifier: `ENG-created-${ordinal}`, title: input.title });
    this.issuesById.set(created.identifier, created);
    return created;
  }
  async createProject(input: { name: string; teamIds: string[] }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
  async updateProjectStatus(input: { projectId: string; type: string }) {
    this.projectStatusCalls.push(input);
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

function makeDeps(linear: FakeLinear, overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  return { linear, github: new GitHubClient(), now: () => new Date("2026-01-01T00:00:00.000Z"), ...overrides };
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

    await applyBoundResult(deps, "foreman-implement", outcome, "ENG-1", "foreman-implement-ENG-1-20260101T000000Z-abc123", null, () => {});

    const updatedIssue = await linear.issue("ENG-1");
    expect(updatedIssue?.labels.some((entry) => entry.name === BLOCKED_LABEL.needsInput)).toBe(true);
    // One comment for the block itself, one for the applied-dispatch marker.
    expect(linear.commentCalls.length).toBe(2);
    // The lock is released as part of the human-block path.
    expect(updatedIssue?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
  });
});

describe("applyBoundResult — cross-issue rejection restores previousStateId", () => {
  it("removes agent:running and restores previousStateId in the same updateIssue call", async () => {
    const lockedIssue = makeIssue({
      id: "issue-1",
      identifier: "ENG-1",
      state: STATE_IN_PROGRESS,
      labels: [label(AGENT_LABEL.running)],
    });
    const otherIssue = makeIssue({ id: "issue-2", identifier: "ENG-9", title: "Someone else's issue", labels: [] });
    const linear = new FakeLinear([lockedIssue, otherIssue]);
    const deps = makeDeps(linear);

    const result = makeRefineResult({ issueId: "ENG-9" });
    const outcome: AgentOutcome = { kind: "result", agent: "foreman-refine", result };

    await applyBoundResult(
      deps,
      "foreman-refine",
      outcome,
      "ENG-1",
      "foreman-refine-ENG-1-20260101T000000Z-abc123",
      STATE_TODO.id,
      () => {},
    );

    const lockedUpdateCalls = linear.updateCalls.filter((call) => call.id === lockedIssue.id);
    expect(lockedUpdateCalls).toHaveLength(1);
    expect(lockedUpdateCalls[0]?.input.removedLabelIds).toContain(label(AGENT_LABEL.running).id);
    expect(lockedUpdateCalls[0]?.input.stateId).toBe(STATE_TODO.id);

    const updatedLocked = await linear.issue("ENG-1");
    expect(updatedLocked?.state.id).toBe(STATE_TODO.id);
    expect(updatedLocked?.labels.some((entry) => entry.name === AGENT_LABEL.running)).toBe(false);
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
      null,
      (message: string, level: string) => notifications.push({ message, level }),
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

    await applyBoundResult(deps, "foreman-refine", outcome, "ENG-1", "foreman-refine-ENG-1-20260101T000000Z-abc123", null, () => {});

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

describe("handleCaptured — concurrent deliveries dedupe in-process", () => {
  it("applies a refine result only once when two channels deliver the same dispatch id", async () => {
    const issue = makeIssue({
      id: "issue-1",
      identifier: "ENG-1",
      state: STATE_TODO,
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.running)],
    });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);
    const dispatchId = "foreman-refine-ENG-1-20260101T000000Z-abc123";
    const payload = {
      blocked: false,
      result: makeRefineResult(),
      block: null,
    };
    const tracker = {
      wasApplied: async () => false,
    };

    await Promise.all([
      handleCaptured(dispatchId, "foreman-refine", payload, false, "ENG-1", null, () => {}, deps, tracker),
      handleCaptured(dispatchId, "foreman-refine", payload, false, "ENG-1", null, () => {}, deps, tracker),
    ]);

    const descriptionUpdates = linear.updateCalls.filter((call) => call.input.description !== undefined);
    expect(descriptionUpdates).toHaveLength(1);
  });
});

/**
 * The regression this file exists to pin: a `foreman-plan` yield used to be
 * dropped between the agent and Linear, silently. Three separate defects had
 * to line up for it to be applied at all — the real `structuredOutput` shape
 * (`status`, not `valid`), a `FOREMAN-DISPATCH` marker on a stage that claims
 * no lock, and a `blocking` agent so the `SingleResult` rides the
 * `tool_result` at all — so this drives the whole chain, from a payload
 * shaped exactly like omp's, through `extractFromToolResult` and
 * `handleCaptured`, to the `createIssue` calls.
 */
describe("handleCaptured — a plan tool_result reaches Linear", () => {
  const PROJECT_ID = "project-1";
  const DISPATCH_ID = `foreman-plan-${PROJECT_ID}-20260101T000000Z-abc123`;
  const TITLES = [
    "Agent defaults: model and thinking-level defaults",
    "Agent defaults: safety ceilings",
    "Terminal preferences pane",
    "Appearance pane: named theme picker",
  ];

  function toolResultPayload(data: unknown) {
    return {
      toolName: "task",
      input: {
        tasks: [
          {
            agent: "foreman-plan",
            task: `Decompose the brief.\n\nFOREMAN-PROJECT: ${PROJECT_ID}\n\nFOREMAN-DISPATCH: ${DISPATCH_ID}\n`,
          },
        ],
      },
      content: [],
      isError: false,
      details: {
        results: [
          {
            index: 0,
            id: "PlanAppSettings",
            agent: "foreman-plan",
            exitCode: 0,
            aborted: false,
            structuredOutput: { source: "agent", mode: "strict", status: "valid", data },
          },
        ],
      },
    };
  }

  function planEnvelope() {
    return {
      blocked: false,
      block: null,
      result: {
        projectId: PROJECT_ID,
        fullyPlanned: true,
        rationale: "Four slices, one per pane plus the ceilings, which have a different consumer story.",
        outOfScope: ["Enforcement of the ceilings in the fleet mesh"],
        // A chain, not a flat list: each slice waits on the previous one, so
        // this fixture also exercises `applyPlan`'s relation pass.
        proposedIssues: TITLES.map((title, index) => ({
          key: `slice-${index}`,
          blockedBy: index === 0 ? [] : [`slice-${index - 1}`],
          title,
          type: TYPE_LABEL.feature,
          description: `## Context\n${title} is a thin surface over existing machinery.`,
          acceptanceCriteria: [`${title} persists its setting`, `${title} rejects out-of-range input`],
          proposedPriority: PRIORITY.Medium,
          proposedEstimate: index === 3 ? 2 : 3,
        })),
      },
    };
  }

  it("creates one Backlog issue per proposedIssue and marks the project planned", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = { id: PROJECT_ID, name: "App settings", description: null, content: "Brief.", startDate: null, targetDate: null, status: null, documents: [] };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];

    const captured = extractFromToolResult(toolResultPayload(planEnvelope()));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.dispatchId).toBe(DISPATCH_ID);

    const notices: string[] = [];
    const reports: AgentReport[] = [];
    await handleCaptured(
      captured[0]!.dispatchId,
      captured[0]!.agent,
      captured[0]!.data,
      captured[0]!.aborted,
      captured[0]!.issueId,
      captured[0]!.previousStateId,
      (message, level) => notices.push(`${level}: ${message}`),
      makeDeps(linear, { entry: { team: "ENG" } }),
      { wasApplied: async () => false },
      async (report) => {
        reports.push(report);
      },
    );

    expect(notices).toEqual([]);
    expect(linear.createIssueCalls.map((call) => call.title)).toEqual(TITLES);
    expect(linear.createIssueCalls.every((call) => call.projectId === PROJECT_ID)).toBe(true);
    // Named explicitly, because Linear's own default for an API-created issue
    // on a triage-enabled team is Triage - the inbox `foreman team` consumes.
    // Eight planned issues landed there once, which is what this asserts away.
    expect(linear.createIssueCalls.map((call) => call.stateId)).toEqual(TITLES.map(() => STATE_BACKLOG.id));
    expect(linear.projectStatusCalls).toEqual([{ projectId: PROJECT_ID, type: "planned" }]);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe("applied");
    expect(reports[0]?.subject).toBe("App settings");
    expect(reports[0]?.created.map((entity) => entity.title)).toEqual(TITLES);
  });

  it("stores a description the parser can read back — one template, not one nested in another", async () => {
    const linear = new FakeLinear([]);
    linear.projectRecord = { id: PROJECT_ID, name: "App settings", description: null, content: "Brief.", startDate: null, targetDate: null, status: null, documents: [] };
    linear.teamsList = [{ id: "team-1", key: "ENG", name: "Engineering" }];

    const captured = extractFromToolResult(toolResultPayload(planEnvelope()));
    await handleCaptured(
      captured[0]!.dispatchId,
      captured[0]!.agent,
      captured[0]!.data,
      captured[0]!.aborted,
      captured[0]!.issueId,
      captured[0]!.previousStateId,
      () => {},
      makeDeps(linear, { entry: { team: "ENG" } }),
      { wasApplied: async () => false },
    );

    const description = linear.createIssueCalls[0]?.description ?? "";
    expect(description.match(/^## Context$/gm)).toHaveLength(1);
    expect(description.match(/^## Acceptance Criteria$/gm)).toHaveLength(1);
    expect(acceptanceCriteria(description)).toEqual([
      `${TITLES[0]} persists its setting`,
      `${TITLES[0]} rejects out-of-range input`,
    ]);
    expect(openQuestions(description)).toEqual([]);
  });

  it("drops nothing on the floor: the same payload with no FOREMAN-DISPATCH marker is never captured", () => {
    const payload = toolResultPayload(planEnvelope());
    payload.input.tasks[0]!.task = `Decompose the brief.\n\nFOREMAN-PROJECT: ${PROJECT_ID}\n`;
    expect(extractFromToolResult(payload)).toEqual([]);
  });
});

describe("handleCaptured — a blocked triage result with no locked issue notifies instead of mutating Linear", () => {
  it("calls notify exactly once with the block's whatINeed, and performs no Linear mutation", async () => {
    const linear = new FakeLinear([]);
    const deps = makeDeps(linear);
    const dispatchId = "foreman-triage-batch-20260101T000000Z-abc123";
    const block = makeBlockRecord({ type: "needs-decision", whatINeed: "Which project owns this batch?" });
    const payload = { blocked: true, result: null, block };

    const notifications: Array<{ message: string; level: string }> = [];
    await handleCaptured(
      dispatchId,
      "foreman-triage",
      payload,
      false,
      null,
      null,
      (message: string, level: string) => notifications.push({ message, level }),
      deps,
      { wasApplied: async () => false },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("Which project owns this batch?");
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
  });
});

