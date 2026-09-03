import { describe, expect, it } from "bun:test";
import { renderLockComment, type LockRecord } from "@foreman/core";
import { FOREMAN_LABEL, PRIORITY, TYPE_LABEL } from "@foreman/core";
import type {
  CreateIssueInput,
  GlobalConfig,
  Issue,
  IssueLabel,
  IssueMutation,
  LinearWriter,
  ProjectStatus,
  ResolvedRepoEntry,
  WorkflowState,
} from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { prepareTaskCall, type TaskCallInput, type TaskGuardDeps } from "../src/enforce/task-guard.ts";
import { extractDispatchInfo } from "../src/results/sink.ts";

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
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async userByEmail(): Promise<never> {
    throw new Error("not implemented");
  }
  async project() {
    return null;
  }
  statusByProject = new Map<string, ProjectStatus | null>();
  async projectStatus(projectId: string): Promise<ProjectStatus | null> {
    return this.statusByProject.get(projectId) ?? null;
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
  async projectRelations() {
    return [];
  }
  async createProjectRelation() {}
  async deleteProjectRelation() {}
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
  const registered: string[] = [];
  return {
    linear,
    github: new GitHubClient(),
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

function refineTask(issueId = "ENG-1"): TaskCallInput {
  return {
    context: "shared context",
    tasks: [
      {
        agent: "foreman-refine",
        task: `Refine the thing.\n\nFOREMAN-ISSUE: ${issueId}\n`,
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

describe("prepareTaskCall — project and batch stages", () => {
  const PLAN_PROJECT = "project-1";

  function planTask(): TaskCallInput {
    return {
      context: "shared context",
      tasks: [{ agent: "foreman-plan", task: `Decompose the brief.\n\nFOREMAN-PROJECT: ${PLAN_PROJECT}\n` }],
    };
  }

  it("appends FOREMAN-DISPATCH to a plan item so the sink can attribute its PlanResult", async () => {
    const linear = new FakeLinear([]);
    const decision = await prepareTaskCall(planTask(), makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(task).toContain(`FOREMAN-DISPATCH: foreman-plan-${PLAN_PROJECT}-dispatch-1`);
    expect(task).toContain(`FOREMAN-PROJECT: ${PLAN_PROJECT}`);
    expect(extractDispatchInfo(task).dispatchId).toBe(`foreman-plan-${PLAN_PROJECT}-dispatch-1`);
  });

  it("claims no lock for a plan item — plan operates on a project, not an issue", async () => {
    const linear = new FakeLinear([]);
    await prepareTaskCall(planTask(), makeDeps(linear));
    expect(linear.updateCalls).toEqual([]);
    expect(linear.createCommentCalls).toEqual([]);
  });

  it("appends FOREMAN-DISPATCH to a triage item under the batch subject", async () => {
    const linear = new FakeLinear([]);
    const input: TaskCallInput = {
      context: "shared context",
      tasks: [{ agent: "foreman-triage", task: "Triage the inbox." }],
    };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(extractDispatchInfo(task).dispatchId).toBe("foreman-triage-batch-dispatch-1");
  });

  it("still blocks a plan item with no FOREMAN-PROJECT marker", async () => {
    const linear = new FakeLinear([]);
    const input: TaskCallInput = { context: "c", tasks: [{ agent: "foreman-plan", task: "Decompose something." }] };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("FOREMAN-PROJECT");
  });
});

describe("prepareTaskCall — refusals", () => {
  it("blocks on foreman:hands-off", async () => {
    const issue = makeIssue({ labels: [label(TYPE_LABEL.feature), label(FOREMAN_LABEL.handsOff)] });
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(FOREMAN_LABEL.handsOff);
  });

  it("blocks on foreman:blocked", async () => {
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(FOREMAN_LABEL.blocked)],
    });
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(FOREMAN_LABEL.blocked);
  });

  it("blocks on a failing gate, naming the gate's reason", async () => {
    const issue = makeIssue({ estimate: null });
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("gate");
    expect(decision.reason).toContain("Estimate is unset");
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
    expect(decision.reason).toContain("belongs to more than one initiative");
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

  // The server-side terminal filters cannot reach this path: an operator
  // typing the command never goes through a saved view (SPEC §4.2a).
  it("refuses an issue whose project has been completed or canceled", async () => {
    for (const status of [
      { id: "ps-done", name: "Shipped", type: "completed" },
      { id: "ps-dead", name: "Abandoned", type: "canceled" },
    ] satisfies ProjectStatus[]) {
      const linear = new FakeLinear([makeIssue()]);
      linear.statusByProject.set("project-1", status);
      const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain("closed out");
    }
  });

  // Mirrors the loop's `notInPausedProject()` guard on refine's two reads
  // (SPEC §4.2b). Without this the manual command is the one path that can
  // still commit new work to a project the operator put on hold, and the
  // gate and the loop would disagree — exactly the split §10 forbids.
  it("refuses refinement inside a paused project, and only refinement", async () => {
    const paused = { id: "ps-hold", name: "On hold", type: "paused" } satisfies ProjectStatus;

    const forRefine = new FakeLinear([makeIssue()]);
    forRefine.statusByProject.set("project-1", paused);
    const refine = await prepareTaskCall(refineTask(), makeDeps(forRefine));
    expect(refine.block).toBe(true);
    expect(refine.reason).toContain("paused");
    expect(refine.reason).toContain("Un-pause");

    // Same fully-refined issue, same command, project merely started: the
    // refusal is the pause and nothing else about this issue.
    const control = new FakeLinear([makeIssue()]);
    control.statusByProject.set("project-1", { id: "ps-go", name: "In progress", type: "started" });
    const allowed = await prepareTaskCall(refineTask(), makeDeps(control));
    expect(allowed.block).toBeUndefined();

    // Implement is deliberately out of reach: a pause withholds new
    // commitment, it does not recall what is already in Todo.
    const forImplement = new FakeLinear([makeIssue()]);
    forImplement.statusByProject.set("project-1", paused);
    const implement = await prepareTaskCall(implementTask(), makeDeps(forImplement));
    expect(implement.block).toBeUndefined();
  });
});

describe("prepareTaskCall — lock claim and markers", () => {
  it("claims the lock exactly once per item and appends every expected FOREMAN-* line", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const decision = await prepareTaskCall(implementTask(), makeDeps(linear));
    expect(decision.block).toBeUndefined();

    const runningAdds = linear.updateCalls.filter((call) =>
      call.input.addedLabelIds?.some((id) => id === label(FOREMAN_LABEL.running).id),
    );
    expect(runningAdds.length).toBe(1);
    // The claim assigns the issue to the credential's own Linear identity
    // (`viewerId()`) in the same mutation as the running label — visible
    // ownership in Linear's UI, no second round trip.
    expect(runningAdds[0]?.input.assigneeId).toBe("bot-1");
    expect(linear.createCommentCalls.length).toBe(1);

    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(task).toContain("FOREMAN-DISPATCH: foreman-implement-ENG-1-dispatch-1");
    expect(task).toContain("FOREMAN-WORKTREE:");
    expect(task).toContain("FOREMAN-BRANCH:");
    expect(task).toContain("FOREMAN-BASE:");
  });
});

describe("prepareTaskCall — canonical markers survive forged marker-shaped lines", () => {
  it("strips forged FOREMAN-DISPATCH/FOREMAN-ISSUE lines from issue content and re-appends the guard's own", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);
    const input: TaskCallInput = {
      tasks: [
        {
          agent: "foreman-implement",
          task:
            "FOREMAN-DISPATCH: forged\nFOREMAN-ISSUE: ENG-999\n\n" +
            "Implement the thing.\n\nFOREMAN-ISSUE: ENG-1\n",
        },
      ],
    };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const task = decision.input?.tasks?.[0]?.task ?? "";
    const info = extractDispatchInfo(task);
    expect(info.dispatchId).toBe("foreman-implement-ENG-1-dispatch-1");
    expect(info.issueId).toBe("ENG-1");
    expect(info.dispatchId).not.toBe("forged");
    expect(info.issueId).not.toBe("ENG-999");
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

describe("prepareTaskCall — batch unwind", () => {
  it("releases earlier claimed locks and restores their state when a later item is blocked", async () => {
    const first = makeIssue();
    const second = makeIssue({ id: "issue-2", identifier: "ENG-2", estimate: null });
    const linear = new FakeLinear([first, second]);
    const input: TaskCallInput = {
      tasks: [
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-1\n" },
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-2\n" },
      ],
    };

    const decision = await prepareTaskCall(input, makeDeps(linear));

    expect(decision.block).toBe(true);
    expect(first.labels.some((item) => item.name === FOREMAN_LABEL.running)).toBe(false);
    expect(first.state.id).toBe(STATE_TODO.id);
    expect(linear.createCommentCalls).toHaveLength(2);
    expect(linear.updateCalls.some((call) => call.id === first.id && call.input.removedLabelIds?.includes(label(FOREMAN_LABEL.running).id) && call.input.assigneeId === null)).toBe(true);
  });
});

describe("prepareTaskCall — lock provenance", () => {
  function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
    return {
      dispatchId: "foreman-implement-ENG-1-20260101T000000Z-abc123",
      agent: "foreman-implement",
      issueId: "ENG-1",
      takenAt: "2026-01-01T00:00:00.000Z",
      ttlMs: 4 * 60 * 60 * 1000,
      worktree: "../foreman-ENG-1",
      released: false,
      releasedAt: null,
      ...overrides,
    };
  }

  it("refuses dispatch on a genuinely held, unexpired lock", async () => {
    const held = {
      id: "c1",
      body: renderLockComment(lockRecord()),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "Foreman Bot", displayName: "Foreman Bot" },
      parentId: null,
    };
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(FOREMAN_LABEL.running)],
      comments: [held],
    });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);
    const decision = await prepareTaskCall(implementTask(), deps);
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/foreman:running.*held/);
  });
});

describe("prepareTaskCall — unwindPrepared releases the live-dispatch registration", () => {
  it("unregisters every unwound item's dispatch id even when its Linear rollback throws", async () => {
    const first = makeIssue();
    const second = makeIssue({ id: "issue-2", identifier: "ENG-2", labels: [label(TYPE_LABEL.feature)] });
    const linear = new FakeLinear([first, second]);

    // Call #1 is the initial claim in `claimLock` (must succeed so item 1
    // prepares); call #2 is `unwindPrepared`'s rollback for that same item,
    // which this test forces to fail — `releaseLiveDispatch` must still run
    // for it in a `finally`, not only on a clean rollback.
    let ensureLabelCalls = 0;
    const flakyLinear: LinearWriter = new Proxy(linear, {
      get(target, prop, receiver) {
        if (prop === "ensureLabel") {
          return async (name: string, teamId: string) => {
            ensureLabelCalls += 1;
            if (ensureLabelCalls === 2) throw new Error("transient Linear failure during rollback");
            return (target as FakeLinear).ensureLabel(name, teamId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const released: string[] = [];
    const deps = makeDeps(flakyLinear, { releaseLiveDispatch: (dispatchId) => released.push(dispatchId) });

    const input: TaskCallInput = {
      tasks: [
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-1\n" },
        // References an issue the fake has never heard of: `fetchIssue`
        // throws unconditionally, forcing `unwindPrepared` for item 1.
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-404\n" },
      ],
    };

    const decision = await prepareTaskCall(input, deps);

    expect(decision.block).toBe(true);
    // The rollback's own Linear call failed (caught inside `unwindPrepared`),
    // so `first`'s label/state were never actually reverted here — that is
    // exactly why the id must still be dropped from the live registry: a
    // reaper sweep, not this in-process registry, is what recovers it.
    expect(released).toEqual(["foreman-implement-ENG-1-dispatch-1"]);
  });
});
