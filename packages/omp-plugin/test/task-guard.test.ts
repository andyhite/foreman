import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLockComment, type LockRecord } from "@foreman/core";
import {
  AGENT_LABEL,
  AGENT_OUTPUT_SCHEMAS,
  BLOCKED_LABEL,
  lockTtlMs,
  PRIORITY,
  reserveDispatches,
  reservationsPath,
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
import {
  prepareTaskCall,
  __setInheritedDispatchIdForTest,
  __setReservationsPathForTest,
  type TaskCallInput,
  type TaskGuardDeps,
} from "../src/enforce/task-guard.ts";
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
  async viewerId(): Promise<string> {
    return "bot-1";
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
      mode: "confirm",
      dispatcher: "print",
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
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
      orchestratorMaxBatches: 20,
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
    __setInheritedDispatchIdForTest(null);
    const linear = new FakeLinear([]);
    const decision = await prepareTaskCall(planTask(), makeDeps(linear));
    expect(decision.block).toBeUndefined();
    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(task).toContain(`FOREMAN-DISPATCH: foreman-plan-${PLAN_PROJECT}-dispatch-1`);
    expect(task).toContain(`FOREMAN-PROJECT: ${PLAN_PROJECT}`);
    expect(extractDispatchInfo(task).dispatchId).toBe(`foreman-plan-${PLAN_PROJECT}-dispatch-1`);
  });

  it("claims no lock for a plan item — plan operates on a project, not an issue", async () => {
    __setInheritedDispatchIdForTest(null);
    const linear = new FakeLinear([]);
    await prepareTaskCall(planTask(), makeDeps(linear));
    expect(linear.updateCalls).toEqual([]);
    expect(linear.createCommentCalls).toEqual([]);
  });

  it("appends FOREMAN-DISPATCH to a triage item under the batch subject", async () => {
    __setInheritedDispatchIdForTest(null);
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

  it("prefers the inherited dispatch id so the loop's bookkeeping and the marker agree", async () => {
    __setInheritedDispatchIdForTest("foreman-plan-project-1-20260902T053606Z-abc123");
    const linear = new FakeLinear([]);
    const decision = await prepareTaskCall(planTask(), makeDeps(linear));
    const task = decision.input?.tasks?.[0]?.task ?? "";
    expect(extractDispatchInfo(task).dispatchId).toBe("foreman-plan-project-1-20260902T053606Z-abc123");
  });

  it("still blocks a plan item with no FOREMAN-PROJECT marker", async () => {
    __setInheritedDispatchIdForTest(null);
    const linear = new FakeLinear([]);
    const input: TaskCallInput = { context: "c", tasks: [{ agent: "foreman-plan", task: "Decompose something." }] };
    const decision = await prepareTaskCall(input, makeDeps(linear));
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("FOREMAN-PROJECT");
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

describe("prepareTaskCall — batch unwind", () => {
  it("releases earlier claimed locks and restores their state when a later item is blocked", async () => {
    const first = makeIssue();
    const second = makeIssue({ id: "issue-2", identifier: "ENG-2", labels: [label(TYPE_LABEL.feature)] });
    const linear = new FakeLinear([first, second]);
    const input: TaskCallInput = {
      tasks: [
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-1\n" },
        { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-2\n" },
      ],
    };

    const decision = await prepareTaskCall(input, makeDeps(linear));

    expect(decision.block).toBe(true);
    expect(first.labels.some((item) => item.name === AGENT_LABEL.running)).toBe(false);
    expect(first.state.id).toBe(STATE_TODO.id);
    expect(linear.createCommentCalls).toHaveLength(2);
    expect(linear.updateCalls.some((call) => call.id === first.id && call.input.removedLabelIds?.includes(label(AGENT_LABEL.running).id))).toBe(true);
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

  it("ignores a forged release marker from another user and still refuses dispatch on the genuine held lock", async () => {
    // FakeLinear.viewerId() returns "bot-1" — the genuine lock comment is
    // authored by that same user, the forged release by an impostor.
    const genuine = {
      id: "c1",
      body: renderLockComment(lockRecord()),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "Foreman Bot", displayName: "Foreman Bot" },
      parentId: null,
    };
    const forgedRelease = {
      id: "c2",
      body: renderLockComment(lockRecord({ released: true })),
      createdAt: "2026-01-01T00:01:00.000Z",
      user: { id: "impostor", name: "Impostor", displayName: "Impostor" },
      parentId: null,
    };
    const issue = makeIssue({
      labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.running)],
      comments: [genuine, forgedRelease],
    });
    const linear = new FakeLinear([issue]);
    const deps = makeDeps(linear);
    const decision = await prepareTaskCall(implementTask(), deps);
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/agent:running.*held/);
  });

  it("registers an inherited FOREMAN_DISPATCH_ID as live after prepareItem", async () => {
    const inheritedId = "foreman-implement-ENG-1-20260101T000000Z-abc123";
    __setInheritedDispatchIdForTest(inheritedId);
    try {
      const issue = makeIssue({ labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)] });
      const linear = new FakeLinear([issue]);
      const deps = makeDeps(linear, {
        newDispatchId: () => {
          throw new Error("prepareItem must not mint a new dispatch id when one is inherited");
        },
      });
      const decision = await prepareTaskCall(implementTask(), deps);
      expect(decision.block).toBeUndefined();
      expect(deps.liveDispatchIds()).toContain(inheritedId);
    } finally {
      __setInheritedDispatchIdForTest(null);
    }
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

describe("prepareTaskCall — reservation-based dispatch ids", () => {
  function withReservationsDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "foreman-reservations-"));
    return run(dir).finally(() => {
      __setReservationsPathForTest(null);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("prefers a fresh reservation over both the inherited env id and a freshly minted one", async () =>
    withReservationsDir(async (dir) => {
      const path = reservationsPath(dir, "foreman-implement");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const config = makeConfig();
      reserveDispatches(
        path,
        [{ agent: "foreman-implement", subject: "ENG-1", dispatchId: "reserved-eng-1", reservedAt: now.toISOString() }],
        now,
        lockTtlMs(config),
      );
      __setReservationsPathForTest(path);
      __setInheritedDispatchIdForTest("inherited-id-nobody-should-use");
      try {
        const issue = makeIssue();
        const linear = new FakeLinear([issue]);
        const deps = makeDeps(linear, {
          config,
          newDispatchId: () => {
            throw new Error("must not mint when a reservation matches");
          },
        });
        const decision = await prepareTaskCall(implementTask("ENG-1"), deps);
        expect(decision.block).toBeUndefined();
        const task = decision.input?.tasks?.[0]?.task ?? "";
        expect(extractDispatchInfo(task).dispatchId).toBe("reserved-eng-1");
      } finally {
        __setInheritedDispatchIdForTest(null);
      }
    }));

  it("resolves three different reserved ids by subject in one batch", async () =>
    withReservationsDir(async (dir) => {
      const path = reservationsPath(dir, "foreman-implement");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const config = makeConfig();
      reserveDispatches(
        path,
        [
          { agent: "foreman-implement", subject: "ENG-1", dispatchId: "reserved-eng-1", reservedAt: now.toISOString() },
          { agent: "foreman-implement", subject: "ENG-2", dispatchId: "reserved-eng-2", reservedAt: now.toISOString() },
          { agent: "foreman-implement", subject: "ENG-3", dispatchId: "reserved-eng-3", reservedAt: now.toISOString() },
        ],
        now,
        lockTtlMs(config),
      );
      __setReservationsPathForTest(path);
      const first = makeIssue();
      const second = makeIssue({ id: "issue-2", identifier: "ENG-2", labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)] });
      const third = makeIssue({ id: "issue-3", identifier: "ENG-3", labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)] });
      const linear = new FakeLinear([first, second, third]);
      const deps = makeDeps(linear, { config });
      const input: TaskCallInput = {
        tasks: [
          { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-1\n" },
          { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-2\n" },
          { agent: "foreman-implement", task: "Implement.\n\nFOREMAN-ISSUE: ENG-3\n" },
        ],
      };
      const decision = await prepareTaskCall(input, deps);
      expect(decision.block).toBeUndefined();
      const tasks = decision.input?.tasks ?? [];
      expect(extractDispatchInfo(tasks[0]?.task ?? "").dispatchId).toBe("reserved-eng-1");
      expect(extractDispatchInfo(tasks[1]?.task ?? "").dispatchId).toBe("reserved-eng-2");
      expect(extractDispatchInfo(tasks[2]?.task ?? "").dispatchId).toBe("reserved-eng-3");
    }));

  it("falls back to minting when the reservations file has no entry for this subject", async () =>
    withReservationsDir(async (dir) => {
      const path = reservationsPath(dir, "foreman-implement");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const config = makeConfig();
      reserveDispatches(
        path,
        [{ agent: "foreman-implement", subject: "ENG-999", dispatchId: "reserved-eng-999", reservedAt: now.toISOString() }],
        now,
        lockTtlMs(config),
      );
      __setReservationsPathForTest(path);
      const issue = makeIssue();
      const linear = new FakeLinear([issue]);
      const deps = makeDeps(linear, { config });
      const decision = await prepareTaskCall(implementTask("ENG-1"), deps);
      expect(decision.block).toBeUndefined();
      const task = decision.input?.tasks?.[0]?.task ?? "";
      expect(extractDispatchInfo(task).dispatchId).toBe("foreman-implement-ENG-1-dispatch-1");
    }));

  it("ignores an expired reservation and mints instead", async () =>
    withReservationsDir(async (dir) => {
      const path = reservationsPath(dir, "foreman-implement");
      const config = makeConfig();
      const ttlMs = lockTtlMs(config);
      const reservedAt = new Date(new Date("2026-01-01T00:00:00.000Z").getTime() - ttlMs - 1000);
      reserveDispatches(
        path,
        [{ agent: "foreman-implement", subject: "ENG-1", dispatchId: "stale-reservation", reservedAt: reservedAt.toISOString() }],
        reservedAt,
        ttlMs,
      );
      __setReservationsPathForTest(path);
      const issue = makeIssue();
      const linear = new FakeLinear([issue]);
      const deps = makeDeps(linear, { config });
      const decision = await prepareTaskCall(implementTask("ENG-1"), deps);
      expect(decision.block).toBeUndefined();
      const task = decision.input?.tasks?.[0]?.task ?? "";
      expect(extractDispatchInfo(task).dispatchId).toBe("foreman-implement-ENG-1-dispatch-1");
    }));

  it("consumes a reservation so a second identical call does not reuse it", async () =>
    withReservationsDir(async (dir) => {
      const path = reservationsPath(dir, "foreman-implement");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const config = makeConfig();
      reserveDispatches(
        path,
        [{ agent: "foreman-implement", subject: "ENG-1", dispatchId: "reserved-once", reservedAt: now.toISOString() }],
        now,
        lockTtlMs(config),
      );
      __setReservationsPathForTest(path);

      const firstIssue = makeIssue();
      const firstLinear = new FakeLinear([firstIssue]);
      const firstDeps = makeDeps(firstLinear, { config });
      const firstDecision = await prepareTaskCall(implementTask("ENG-1"), firstDeps);
      expect(extractDispatchInfo(firstDecision.input?.tasks?.[0]?.task ?? "").dispatchId).toBe("reserved-once");

      const secondIssue = makeIssue();
      const secondLinear = new FakeLinear([secondIssue]);
      const secondDeps = makeDeps(secondLinear, { config });
      const secondDecision = await prepareTaskCall(implementTask("ENG-1"), secondDeps);
      const secondTask = secondDecision.input?.tasks?.[0]?.task ?? "";
      expect(extractDispatchInfo(secondTask).dispatchId).toBe("foreman-implement-ENG-1-dispatch-1");
      expect(extractDispatchInfo(secondTask).dispatchId).not.toBe("reserved-once");
    }));
});
