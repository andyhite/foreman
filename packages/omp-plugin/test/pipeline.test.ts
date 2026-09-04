import { describe, expect, it } from "bun:test";
import {
  FOREMAN_STATE,
  GitHubClient,
  MARKER_KIND,
  PRIORITY,
  TYPE_LABEL,
  decodeMarker,
  readLockComment,
} from "@foreman/core";
import type {
  CreateIssueInput,
  GlobalConfig,
  ImplementResult,
  Issue,
  IssueLabel,
  IssueMutation,
  LinearWriter,
  ProjectStatus,
  RefineResult,
  ResolvedRepoEntry,
  TeamSettings,
  WorkflowState,
} from "@foreman/core";
import type { CommandRunner } from "@foreman/core";
import { prepareTaskCall, type TaskCallInput, type TaskGuardDeps } from "../src/enforce/task-guard.ts";
import { applyOutcome, type ApplyDeps } from "../src/results/apply.ts";

// This is the plan's mandatory end-to-end proof: one issue, one fake, three
// consecutive stage dispatches interleaved with their applied results. Each
// leg pins one specific defect fixed elsewhere in the sweep:
//   - the refine dispatch proves the refine-entry gate (not the refinement
//     exit gate) now gates a `foreman-refine` dispatch;
//   - the post-refine implement dispatch proves the lock-release marker fix
//     — before it, this dispatch failed with "Lock held: ... within TTL.";
//   - the post-implement review dispatch proves the pipeline keeps running
//     past a second stage transition on the same issue.

const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: FOREMAN_STATE.backlog, type: "backlog", position: 0 };
const STATE_READY: WorkflowState = { id: "state-ready", name: FOREMAN_STATE.ready, type: "unstarted", position: 2 };
const STATE_REFINING: WorkflowState = { id: "state-refining", name: FOREMAN_STATE.refining, type: "unstarted", position: 1 };
const STATE_IN_PROGRESS: WorkflowState = { id: "state-in-progress", name: FOREMAN_STATE.inProgress, type: "started", position: 3 };
const STATE_IN_REVIEW: WorkflowState = { id: "state-in-review", name: FOREMAN_STATE.inReview, type: "started", position: 4 };
const KNOWN_STATES = [STATE_BACKLOG, STATE_READY, STATE_REFINING, STATE_IN_PROGRESS, STATE_IN_REVIEW];

function label(name: string): IssueLabel {
  return { id: `label-${name}`, name, parentId: null };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: "Search feels slow.",
    priority: PRIORITY.Medium,
    estimate: null,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_BACKLOG,
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

/**
 * `LinearWriter` fake shared by both the guard and the applier. Unlike the
 * per-file fakes in `task-guard.test.ts`/`apply.test.ts`, `createComment`
 * here actually appends to the target issue's `comments` array — required
 * for this test, since it round-trips a lock claimed by one call through a
 * release read by a later one, on the same issue.
 */
class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  createCommentCalls: Array<{ issueId: string; body: string }> = [];
  labelsById = new Map<string, IssueLabel>();
  statusByProject = new Map<string, ProjectStatus | null>();

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
  async userByEmail(): Promise<null> {
    return null;
  }
  async project() {
    return null;
  }
  async projectStatus(projectId: string): Promise<ProjectStatus | null> {
    return this.statusByProject.get(projectId) ?? null;
  }
  async teamDocuments() {
    return [];
  }
  async createDocument(): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async updateDocument(): Promise<never> {
    throw new Error("not implemented in fake");
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return KNOWN_STATES;
  }
  async labels(): Promise<IssueLabel[]> {
    return [...this.labelsById.values()];
  }
  async teams() {
    return [{ id: "team-1", key: "ENG", name: "Engineering" }];
  }
  async projects() {
    return [];
  }
  async teamSettings(): Promise<TeamSettings> {
    return { id: "team-1", key: "ENG", name: "Engineering", triageEnabled: true, cyclesEnabled: false, triageStateId: null };
  }
  async projectLabels(): Promise<IssueLabel[]> {
    return [];
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = this.byId(id);
    if (input.addedLabelIds) {
      const added = input.addedLabelIds
        .map((labelId) => [...this.labelsById.values()].find((l) => l.id === labelId))
        .filter((l): l is IssueLabel => l !== undefined);
      issue.labels = [...issue.labels, ...added];
    }
    if (input.removedLabelIds) {
      issue.labels = issue.labels.filter((l) => !input.removedLabelIds?.includes(l.id));
    }
    if (input.stateId) {
      issue.state = KNOWN_STATES.find((s) => s.id === input.stateId) ?? issue.state;
    }
    if (input.assigneeId !== undefined) {
      issue.assignee = input.assigneeId ? { id: input.assigneeId, name: input.assigneeId, displayName: input.assigneeId } : null;
    }
    if (input.description !== undefined) issue.description = input.description;
    if (input.estimate !== undefined) issue.estimate = input.estimate;
    return issue;
  }
  async createIssue(input: CreateIssueInput): Promise<Issue> {
    return makeIssue({ id: `created-${input.title}`, title: input.title });
  }
  async createProject(input: { name: string; teamIds: string[]; description?: string; content?: string; labelIds?: string[] }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async updateProjectStatus() {}
  async createComment(input: { issueId: string; body: string; parentId?: string }) {
    this.createCommentCalls.push(input);
    const comment = {
      id: `comment-${this.createCommentCalls.length}`,
      body: input.body,
      createdAt: new Date().toISOString(),
      user: { id: "bot-1", name: "Foreman Bot", displayName: "Foreman Bot" },
      parentId: input.parentId ?? null,
    };
    // Real Linear would surface this on the next `issue(..., {includeComments:
    // true})` read; mutate the same object in place so this fake does too —
    // the whole point of this test is that a lock claimed by one dispatch is
    // visible to a later release/claim against the same issue.
    const issue = this.byId(input.issueId);
    issue.comments = [...issue.comments, comment];
    return comment;
  }
  async createRelation() {}
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
    const existing = [...this.labelsById.values()].find((l) => l.name === name);
    if (existing) return existing;
    return this.createLabel({ name });
  }
  async ensureWorkspaceLabel(name: string): Promise<IssueLabel> {
    return this.ensureLabel(name);
  }
  async ensureProjectLabel(name: string): Promise<IssueLabel> {
    return label(name);
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

function makeConfig(): GlobalConfig {
  return {
    repos: { test: { path: "/repo", team: "ENG" } },
    loop: {
      mode: "confirm",
      cleanupMergedWorktrees: true,
      autoMerge: false,
      retryCap: 2,
      reviewCycleCap: 2,
      stateDir: "~/.foreman/state",
      concurrency: { plan: 1, build: 3 },
      pollSeconds: 20,
      triageBatch: 10,
    },
    linear: {
      apiKeyEnv: "LINEAR_API_KEY",
      apiKeyFile: null,
      endpoint: "https://api.linear.app/graphql",
      allowCustomEndpoint: false,
      operatorUserId: null,
    },
    githubApp: { appId: null, privateKeyFile: null },
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
      dispatcher: "print",
    },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  } as GlobalConfig;
}

function makeEntry(overrides: Partial<ResolvedRepoEntry> = {}): ResolvedRepoEntry {
  return {
    alias: "test",
    repoPath: "/repo",
    team: "ENG",
    apps: [],
    appNames: [],
    baseBranch: "main",
    pr: { required: true, draft: false, ciRequired: true },
    merge: { strategy: "squash", deleteBranch: true },
    branchPattern: "<issue-id>-<slug>",
    worktreePattern: "../<repo>-<ISSUE-ID>",
    ...overrides,
  };
}

/** A `gh`/`git` stub: reports an open PR for any branch, so the `foreman-review` dispatch's `prForBranch` + `prDiff` calls (`pr.required: true`) never shell out for real. */
function stubGithub(): GitHubClient {
  const runner: CommandRunner = {
    async run(argv: string[]) {
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              url: "https://github.com/org/repo/pull/7",
              headRefOid: "abc123",
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              baseRefName: "main",
            },
          ]),
          stderr: "",
          code: 0,
        };
      }
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "diff") {
        return { stdout: "diff --git a/x b/x\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  return new GitHubClient({ runner });
}

function makeGuardDeps(linear: LinearWriter, overrides: Partial<TaskGuardDeps> = {}): TaskGuardDeps {
  const registered: string[] = [];
  return {
    linear,
    github: stubGithub(),
    config: makeConfig(),
    entry: makeEntry(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newDispatchId: (agent, issueId) => `${agent}-${issueId}-dispatch-1`,
    registerLiveDispatch: (dispatchId) => {
      if (!registered.includes(dispatchId)) registered.push(dispatchId);
    },
    ensureWorktree: async (input) => ({ created: true, branchExisted: false, worktreePath: input.worktreePath }),
    writeDiffFile: async () => "/tmp/diff.patch",
    liveDispatchIds: () => registered,
    releaseLiveDispatch: (dispatchId) => {
      const index = registered.indexOf(dispatchId);
      if (index >= 0) registered.splice(index, 1);
    },
    contextDigest: async () => "## Project Context\nSome context.",
    ...overrides,
  };
}

function makeApplyDeps(linear: LinearWriter): ApplyDeps {
  return {
    linear,
    github: new GitHubClient(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    entry: makeEntry(),
    operatorUserId: null,
  };
}

function taskFor(agent: string, issueId: string): TaskCallInput {
  return {
    context: "shared context",
    tasks: [{ agent, task: `Do the stage's work.\n\nFOREMAN-ISSUE: ${issueId}\n` }],
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

function makeImplementResult(overrides: Partial<ImplementResult> = {}): ImplementResult {
  return {
    issueId: "ENG-1",
    branch: "eng-1-do-the-thing",
    prUrl: "https://github.com/org/repo/pull/7",
    headSha: "abc123",
    criteriaMet: [],
    testsAdded: [],
    discoveredWork: [],
    contextContradictions: [],
    approachSummary: "Did the thing.",
    ...overrides,
  };
}

describe("pipeline — refine, implement, review dispatch consecutively on one issue", () => {
  it("runs a full stage sequence: refine dispatch, refine apply, implement dispatch, implement apply, review dispatch", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);

    // Leg 1 — the refine-entry gate (1.2), not the refinement exit gate,
    // gates a `foreman-refine` dispatch: an unrefined Backlog issue with no
    // acceptance criteria and no estimate must be allowed.
    const refineDecision = await prepareTaskCall(taskFor("foreman-refine", issue.identifier), makeGuardDeps(linear));
    expect(refineDecision.block).toBeUndefined();
    expect(issue.state.id).toBe(STATE_REFINING.id);

    // Leg 2 — apply the refine result. `applyRefine`'s `releaseLock` must
    // post a `released: true` marker (1.1), or the very next dispatch on
    // this issue is refused for the lock's full TTL.
    await applyOutcome(makeApplyDeps(linear), {
      kind: "result",
      agent: "foreman-refine",
      result: makeRefineResult({ issueId: issue.identifier }),
    });
    expect(issue.state.id).toBe(STATE_READY.id);
    const afterRefineRelease = readLockComment(issue.comments, "bot-1");
    expect(afterRefineRelease?.data.released).toBe(true);
    expect(decodeMarker(MARKER_KIND.lock, issue.comments[issue.comments.length - 1]!.body)).not.toBeNull();

    // Leg 3 — dispatch `foreman-implement` for the SAME issue in the SAME
    // fake. Before the 1.1 fix, this failed with
    // "Lock held: Lock is held and within TTL." because `releaseLock` only
    // cleared the assignee and never posted the released marker.
    const implementDecision = await prepareTaskCall(taskFor("foreman-implement", issue.identifier), makeGuardDeps(linear));
    expect(implementDecision.block).toBeUndefined();
    expect(implementDecision.reason).toBeUndefined();
    expect(issue.state.id).toBe(STATE_IN_PROGRESS.id);

    // Leg 4 — apply the implement result, releasing the lock again.
    await applyOutcome(makeApplyDeps(linear), {
      kind: "result",
      agent: "foreman-implement",
      result: makeImplementResult({ issueId: issue.identifier }),
    });
    expect(issue.state.id).toBe(STATE_IN_REVIEW.id);
    const afterImplementRelease = readLockComment(issue.comments, "bot-1");
    expect(afterImplementRelease?.data.released).toBe(true);

    // Leg 5 — dispatch `foreman-review` for the same issue: the pipeline
    // keeps running past a second stage transition, not just the first.
    const reviewDecision = await prepareTaskCall(taskFor("foreman-review", issue.identifier), makeGuardDeps(linear));
    expect(reviewDecision.block).toBeUndefined();
    expect(reviewDecision.reason).toBeUndefined();
  });
});
