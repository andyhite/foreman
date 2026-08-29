import { describe, expect, it } from "bun:test";
import {
  AGENT_LABEL,
  AGENT_OUTPUT_SCHEMAS,
  BLOCKED_LABEL,
  PRIORITY,
  TYPE_LABEL,
} from "@foreman/core";
import type {
  CreateIssueInput,
  GlobalConfig,
  Issue,
  IssueLabel,
  IssueMutation,
  LinearWriter,
  ResolvedRepoEntry,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { prepareTaskCall, type TaskCallInput, type TaskGuardDeps } from "../src/enforce/task-guard.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_PROGRESS: WorkflowState = {
  id: "state-in-progress",
  name: "In Progress",
  type: "started",
  position: 3,
};

function label(name: string): IssueLabel {
  return { id: `label-${name}`, name, parentId: null };
}

const ACCEPTANCE_CRITERIA = "## Acceptance Criteria\n- [ ] Does the thing\n";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: `## Context\nWhy.\n\n${ACCEPTANCE_CRITERIA}`,
    priority: PRIORITY.Medium,
    estimate: 2,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_TODO,
    labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)],
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

/** Minimal in-memory `LinearWriter` fake recording every mutation call. */
class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  createCommentCalls: Array<{ issueId: string; body: string }> = [];
  labelsById = new Map<string, IssueLabel>();
  initiativesByProject = new Map<string, { id: string; name: string }[]>();

  constructor(issues: Issue[]) {
    for (const issue of issues) this.issuesById.set(issue.identifier, issue);
  }

  async issue(id: string): Promise<Issue | null> {
    return this.issuesById.get(id) ?? null;
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
  async projectStatus() {
    return null;
  }
  async projectInitiatives(projectId: string) {
    return this.initiativesByProject.get(projectId) ?? [{ id: "initiative-1", name: "Foreman" }];
  }
  async projectInitiative(projectId: string) {
    const refs = await this.projectInitiatives(projectId);
    const first = refs[0];
    if (refs.length !== 1 || !first) throw new Error(`project ${projectId} has ${refs.length} initiatives`);
    return first;
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
    return [];
  }
  async projects() {
    return [];
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = [...this.issuesById.values()].find((candidate) => candidate.id === id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
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
      issue.state = [STATE_TODO, STATE_IN_PROGRESS].find((s) => s.id === input.stateId) ?? issue.state;
    }
    return issue;
  }
  async createIssue(input: CreateIssueInput): Promise<Issue> {
    return makeIssue({ id: `created-${input.title}`, title: input.title });
  }
  async createProject(input: { name: string; teamIds: string[]; description?: string; content?: string }) {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
  async updateProjectStatus() {}
  async createComment(input: { issueId: string; body: string; parentId?: string }) {
    this.createCommentCalls.push(input);
    return { id: "comment-1", body: input.body, createdAt: new Date().toISOString(), user: null, parentId: input.parentId ?? null };
  }
  async createRelation() {}
  async deleteRelation() {}
  async createLabel(input: { name: string; teamId?: string }): Promise<IssueLabel> {
    const created = label(input.name);
    this.labelsById.set(created.id, created);
    return created;
  }
  async ensureLabel(name: string, teamId: string): Promise<IssueLabel> {
    const existing = [...this.labelsById.values()].find((l) => l.name === name);
    if (existing) return existing;
    return this.createLabel({ name, teamId });
  }
}

function makeConfig(): GlobalConfig {
  return {
    repos: {
      test: {
        path: "/repo",
        team: "ENG",
        initiatives: ["initiative-1"],
      },
    },
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      stage: "dry-run",
      dispatcher: "print",
      mergeDetection: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20 },
    linear: {
      apiKeyEnv: "LINEAR_API_KEY",
      apiKeyFile: null,
      endpoint: "https://api.linear.app/graphql",
    },
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
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

/** The registry entry `makeConfig()`'s `repos.test` resolves to — repoDefaults already merged in. */
function makeEntry(overrides: Partial<ResolvedRepoEntry> = {}): ResolvedRepoEntry {
  return {
    alias: "test",
    repoPath: "/repo",
    team: "ENG",
    initiativeIds: ["initiative-1"],
    baseBranch: "main",
    pr: { required: true, draft: false, ciRequired: true },
    merge: { strategy: "squash", deleteBranch: true },
    branchPattern: "<issue-id>-<slug>",
    worktreePattern: "../<repo>-<ISSUE-ID>",
    ...overrides,
  };
}

function makeDeps(linear: LinearWriter, overrides: Partial<TaskGuardDeps> = {}): TaskGuardDeps {
  return {
    linear,
    github: new GitHubClient(),
    config: makeConfig(),
    entry: makeEntry(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newDispatchId: (agent, issueId) => `${agent}-${issueId}-dispatch-1`,
    ensureWorktree: async (input) => ({ created: true, branchExisted: false, worktreePath: input.worktreePath }),
    writeDiffFile: async () => "/tmp/diff.patch",
    liveDispatchIds: () => [],
    contextDigest: async () => "## Project Context\nSome context.",
    ...overrides,
  };
}

function implementTask(issueId = "ENG-1"): TaskCallInput {
  return {
    context: "shared context",
    tasks: [
      {
        agent: "foreman-implement",
        task: `Implement the thing.\n\nFOREMAN-ISSUE: ${issueId}\n`,
      },
    ],
  };
}

describe("prepareTaskCall — schemaMode and isolation", () => {
  it("forces schemaMode strict and strips isolated on a foreman-* item, leaving non-Foreman items untouched", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const input: TaskCallInput = {
      tasks: [
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-1\n", isolated: true },
        { agent: "some-other-agent", task: "do a thing", isolated: true, schemaMode: "permissive" },
      ],
    };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const tasks = decision.input?.tasks ?? [];
    expect(tasks[0]?.schemaMode).toBe("strict");
    expect(tasks[0]?.isolated).toBeUndefined();
    expect(tasks[1]?.schemaMode).toBe("permissive");
    expect(tasks[1]?.isolated).toBe(true);
  });

  it("leaves outputSchema unset (frontmatter carries it) but still blocks an unrecognized foreman-* agent", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const task = decision.input?.tasks?.[0];
    expect(task?.outputSchema).toBeUndefined();
    expect(task?.schemaMode).toBe("strict");

    const bogus: TaskCallInput = {
      tasks: [{ agent: "foreman-bogus", task: "FOREMAN-ISSUE: ENG-1\n" }],
    };
    const blocked = await prepareTaskCall(bogus, makeDeps(new FakeLinear([issue])));
    expect(blocked.block).toBe(true);
  });
});

describe("prepareTaskCall — marker requirement", () => {
  it("blocks a missing FOREMAN-ISSUE marker", async () => {
    const linear = new FakeLinear([makeIssue()]);
    const input: TaskCallInput = {
      tasks: [{ agent: "foreman-implement", task: "Implement the thing with no marker." }],
    };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("FOREMAN-ISSUE");
  });
});

describe("prepareTaskCall — refusals", () => {
  it("blocks on agent:hands-off", async () => {
    const issue = makeIssue({ labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.handsOff)] });
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(AGENT_LABEL.handsOff);
  });

  it("blocks on a blocked:* label", async () => {
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready), label(BLOCKED_LABEL.needsInput)],
    });
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(BLOCKED_LABEL.needsInput);
  });

  it("blocks on a failing gate, naming the gate's reason", async () => {
    const issue = makeIssue({ labels: [label(TYPE_LABEL.feature)] }); // missing agent:ready
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("gate");
    expect(decision.reason).toContain(AGENT_LABEL.ready);
  });

  it("blocks on ambiguous-initiative when the project belongs to more than one initiative", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    linear.initiativesByProject.set("project-1", [
      { id: "initiative-1", name: "Foreman" },
      { id: "initiative-2", name: "Other" },
    ]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("belongs to 2 initiatives");
  });

  it("refuses an out-of-scope issue instead of guessing (SPEC §3.11)", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    linear.initiativesByProject.set("project-1", [{ id: "initiative-2", name: "Other" }]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("initiative-2");
    expect(decision.reason).toContain("not bound");
  });
});

describe("prepareTaskCall — lock claim and markers", () => {
  it("claims the lock exactly once per item and appends every expected FOREMAN-* line", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBeUndefined();

    const runningAdds = linear.updateCalls.filter((call) =>
      call.input.addedLabelIds?.some((id) => id === label(AGENT_LABEL.running).id),
    );
    expect(runningAdds.length).toBe(1);
    expect(linear.createCommentCalls.length).toBe(1);

    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(task).toContain("FOREMAN-DISPATCH: foreman-implement-ENG-1-dispatch-1");
    expect(task).toContain("FOREMAN-WORKTREE:");
    expect(task).toContain("FOREMAN-BRANCH:");
    expect(task).toContain("FOREMAN-BASE:");
  });
});

describe("prepareTaskCall — fail-closed on dependency errors", () => {
  it("converts a thrown dependency error into { block: true } rather than propagating", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear, {
      ensureWorktree: async () => {
        throw new Error("disk full");
      },
    });
    const decision = await prepareTaskCall(implementTask(), deps);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("disk full");
  });
});
