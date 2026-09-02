import { describe, expect, it } from "bun:test";
import type {
  Dispatcher,
  DispatchHandle,
  DispatchOutcome,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
  Initiative,
  InitiativeRef,
  Issue,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  LinearWriter,
  Project,
  ProjectRef,
  TeamRef,
  TriageItem,
  WorkflowState,
} from "@foreman/core";
import { DISPATCH_COMMAND, encodeMarker, INBOX_FILTER as INBOX, MARKER_KIND, PROPOSALS_FILTER as PROPOSED, PRIORITY, TYPE_LABEL } from "@foreman/core";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bookkeeping } from "../src/bookkeeping.ts";
import { SupervisorLock } from "../src/supervisor.ts";
import { pastIntakeWindow, repoEntryForIssue, runIntakeTick, type IntakeContext } from "../src/team.ts";

// ---- fixtures --------------------------------------------------------------

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      mode: "yolo",
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
    ...overrides,
  };
}

let issueSeq = 0;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  issueSeq += 1;
  const id = overrides.identifier ?? `ENG-${issueSeq}`;
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
    description: "a rough bug report",
    priority: 3,
    estimate: null,
    url: `https://linear.app/issue/${id}`,
    branchName: id.toLowerCase(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: { id: "state-triage", name: "Triage", type: "triage", position: 0 },
    labels: [],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "proj-1", name: "Project" },
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

function freshBookkeeping(): Bookkeeping {
  issueSeq += 1;
  const dir = mkdtempSync(join(tmpdir(), `foreman-intake-test-${issueSeq}-`));
  return Bookkeeping.load(join(dir, "bookkeeping.json"));
}

class FakeDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  calls: DispatchRequest[] = [];

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    this.calls.push(request);
    const batchId = `batch-${Math.random().toString(36).slice(2)}`;
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt: new Date().toISOString(),
      batchId,
      pid: null,
      herdr: null,
    }));
  }
  async status(): Promise<DispatchStatus> {
    return "settled";
  }
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return { handle, status: "settled", exitCode: 0, log: "" };
  }
  async available(): Promise<boolean> {
    return true;
  }
}

/** Minimal `LinearWriter` stub: only `issues` and `projectInitiative` are exercised by intake's
 * window/backpressure logic. `updateIssue`, `ensureLabel`, `createComment`, `workflowStates`, and
 * `projects` back the apply pass, which the apply engine drives via `runApplyPass`. */
class FakeLinear implements LinearWriter {
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  private readonly labelsByName = new Map<string, IssueLabel>();

  constructor(
    private readonly inboxIssues: Issue[],
    private readonly proposedIssues: Issue[],
    private readonly initiativeResolver: (projectId: string) => Promise<InitiativeRef> = async () => {
      throw new Error("no project→initiative mapping configured");
    },
  ) {}

  async issue(): Promise<Issue | null> {
    return null;
  }
  async issues(query: IssueQuery): Promise<Issue[]> {
    // Distinguish the two filters used by intake by identity, same trick the
    // real filters use (opaque `IssueFilter` objects) — tests pass distinct
    // filter references and match on them. The apply pass (SPEC §7.1) reuses
    // `INBOX_FILTER`, so it shares the inbox fixture with the triage-batch
    // dispatch check.
    if (query.filter === INBOX) return this.inboxIssues;
    if (query.filter === PROPOSED) return this.proposedIssues;
    return [];
  }
  async comments(): Promise<never[]> {
    return [];
  }
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async project(): Promise<Project | null> {
    return null;
  }
  async projectStatus(): Promise<null> {
    return null;
  }
  async projectInitiatives(): Promise<InitiativeRef[]> {
    throw new Error("not used in these tests");
  }
  async initiativeProjects(): Promise<ProjectRef[]> {
    return [];
  }
  async projectInitiative(projectId: string): Promise<InitiativeRef> {
    return this.initiativeResolver(projectId);
  }
  async initiative(): Promise<Initiative | null> {
    return null;
  }
  async initiatives(): Promise<InitiativeRef[]> {
    return [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [
      { id: "state-triage", name: "Triage", type: "triage", position: 0 },
      { id: "state-backlog", name: "Backlog", type: "backlog", position: 1 },
    ];
  }
  async labels(): Promise<IssueLabel[]> {
    return [];
  }
  async teams(): Promise<TeamRef[]> {
    return [];
  }
  async projects(): Promise<never[]> {
    return [];
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = [...this.inboxIssues, ...this.proposedIssues].find((candidate) => candidate.id === id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
    return issue;
  }
  async createIssue(): Promise<Issue> {
    throw new Error("not used in these tests");
  }
  async createComment(input: { issueId: string; body: string }): Promise<never> {
    this.commentCalls.push(input);
    return { id: `comment-${this.commentCalls.length}`, body: input.body, createdAt: new Date().toISOString(), user: null, parentId: null } as never;
  }
  async createProject(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async addProjectToInitiative(): Promise<void> {}
  async updateProjectStatus(): Promise<void> {}
  async createRelation(): Promise<void> {}
  async deleteRelation(): Promise<void> {}
  async createLabel(): Promise<IssueLabel> {
    throw new Error("not used in these tests");
  }
  async ensureLabel(name: string): Promise<IssueLabel> {
    const existing = this.labelsByName.get(name);
    if (existing) return existing;
    const created: IssueLabel = { id: `label-${name}`, name, parentId: null };
    this.labelsByName.set(name, created);
    return created;
  }
}

function proposalComment(item: TriageItem, createdAt: string) {
  return { id: `comment-proposal-${createdAt}`, body: encodeMarker(MARKER_KIND.proposal, item, "human text"), createdAt, user: null, parentId: null };
}

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

// Real filters are opaque `Record<string, unknown>` objects; intake always
// passes `INBOX_FILTER`/`PROPOSALS_FILTER` from `@foreman/core` — imported
// above under local names so the fake can tell the two calls apart.

function makeContext(overrides: Partial<IntakeContext> & { config: GlobalConfig; linear: LinearWriter; dispatcher: Dispatcher }): IntakeContext {
  return {
    bookkeeping: freshBookkeeping(),
    reservationsDir: mkdtempSync(join(tmpdir(), `foreman-intake-test-reservations-${(issueSeq += 1)}-`)),
    team: "ENG",
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: () => {},
    confirm: async () => true,
    ...overrides,
  };
}

// ---- window guard -----------------------------------------------------------

describe("pastIntakeWindow — window guard (SPEC §3.12)", () => {
  it("is false before the configured window", () => {
    expect(pastIntakeWindow("06:00", new Date("2026-06-01T05:59:00.000Z"), "UTC")).toBe(false);
  });

  it("is true at and after the configured window", () => {
    expect(pastIntakeWindow("06:00", new Date("2026-06-01T06:00:00.000Z"), "UTC")).toBe(true);
    expect(pastIntakeWindow("06:00", new Date("2026-06-01T12:00:00.000Z"), "UTC")).toBe(true);
  });

  it("compares in the configured zone, not the host's, for a fixed instant", () => {
    // 2026-06-01T10:00:00Z is 06:00 in America/New_York (EDT, UTC-4) and
    // 19:00 in Asia/Tokyo — the window guard must follow the configured
    // zone, giving a different answer for the same instant in each.
    const instant = new Date("2026-06-01T10:00:00.000Z");
    expect(pastIntakeWindow("06:00", instant, "America/New_York")).toBe(true);
    expect(pastIntakeWindow("18:00", instant, "America/New_York")).toBe(false);
    expect(pastIntakeWindow("06:00", instant, "Asia/Tokyo")).toBe(true);
    expect(pastIntakeWindow("20:00", instant, "Asia/Tokyo")).toBe(false);
  });
});

describe("runIntakeTick — window guard", () => {
  it("skips dispatch before the window and does not touch the dispatcher", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const linear = new FakeLinear([makeIssue()], []);
    const ctx = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T05:00:00.000Z"),
    });

    const report = await runIntakeTick(ctx);

    expect(report.dispatched).toBe(false);
    expect(report.skipReason).toContain("intake.window");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("dispatches once the window has passed and the batch has not already run today", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const issue = makeIssue();
    const linear = new FakeLinear([issue], []);
    const ctx = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
    });

    const report = await runIntakeTick(ctx);

    expect(report.dispatched).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.agent).toBe("foreman-triage");
    expect(dispatcher.calls[0]?.command).toBe(
      `${DISPATCH_COMMAND.triage} --stale-low-days ${config.intake.staleLowDays} ${issue.identifier}`,
    );
  });

  it("carries a non-default intake.staleLowDays through to the dispatched command", async () => {
    const config = makeConfig({ intake: { window: "06:00", staleLowDays: 30, batchSize: 20, timezone: "UTC" } });
    const dispatcher = new FakeDispatcher();
    const issue = makeIssue();
    const linear = new FakeLinear([issue], []);
    const ctx = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
    });

    const report = await runIntakeTick(ctx);

    expect(report.dispatched).toBe(true);
    expect(dispatcher.calls[0]?.command).toContain("--stale-low-days 30");
  });

  it("does not dispatch a second batch the same calendar day", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const linear = new FakeLinear([makeIssue()], []);
    const ctx = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
    });

    await runIntakeTick(ctx);
    dispatcher.calls.length = 0;
    const second = await runIntakeTick({ ...ctx, now: () => new Date("2026-06-01T18:00:00.000Z") });

    expect(second.dispatched).toBe(false);
    expect(second.skipReason).toContain("already dispatched");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("skips the triage dispatch with 'operator declined' under a denying confirmer, and dispatches under YOLO_CONFIRMER", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const linear = new FakeLinear([makeIssue()], []);
    const declined = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      confirm: async () => false,
    });

    const declinedReport = await runIntakeTick(declined);

    expect(declinedReport.dispatched).toBe(false);
    expect(declinedReport.skipReason).toBe("operator declined");
    expect(dispatcher.calls).toHaveLength(0);

    const approvedLinear = new FakeLinear([makeIssue()], []);
    const approved = makeContext({
      config,
      linear: approvedLinear,
      dispatcher,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      confirm: async () => true,
    });

    const approvedReport = await runIntakeTick(approved);

    expect(approvedReport.dispatched).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
  });
});

// ---- backpressure -----------------------------------------------------------

describe("runIntakeTick — team-wide proposal backpressure (SPEC §17.7)", () => {
  it("skips dispatch once the team-wide proposed count exceeds the threshold", async () => {
    const config = makeConfig({
      loop: { ...makeConfig().loop, backpressureThreshold: 2 },
    });
    const dispatcher = new FakeDispatcher();
    const proposed = [makeIssue(), makeIssue(), makeIssue()];
    const linear = new FakeLinear([makeIssue()], proposed);
    const ctx = makeContext({ config, linear, dispatcher });

    const report = await runIntakeTick(ctx);

    expect(report.proposedCount).toBe(3);
    expect(report.dispatched).toBe(false);
    expect(report.skipReason).toContain("backpressure");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("dispatches when the proposed count is at or below the threshold", async () => {
    const config = makeConfig({
      loop: { ...makeConfig().loop, backpressureThreshold: 2 },
    });
    const dispatcher = new FakeDispatcher();
    const proposed = [makeIssue(), makeIssue()];
    const linear = new FakeLinear([makeIssue()], proposed);
    const ctx = makeContext({ config, linear, dispatcher });

    const report = await runIntakeTick(ctx);

    expect(report.dispatched).toBe(true);
    expect(dispatcher.calls).toHaveLength(1);
  });
});

// ---- apply pass (SPEC §7.1, §3.12) --------------------------------------

describe("runIntakeTick — apply pass (SPEC §7.1)", () => {
  it("applies an approved proposal even though the window is closed", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const item = makeTriageItem();
    const approved = makeIssue({ labels: [], comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([approved], []);
    const ctx = makeContext({
      config,
      linear,
      dispatcher,
      now: () => new Date("2026-06-01T05:00:00.000Z"),
    });

    const report = await runIntakeTick(ctx);

    expect(report.dispatched).toBe(false);
    expect(report.applyPassRan).toBe(true);
    expect(report.appliedCount).toBe(1);
    expect(linear.commentCalls).toHaveLength(1);
  });

  it("applies an approved proposal even though backpressure tripped", async () => {
    const config = makeConfig({
      loop: { ...makeConfig().loop, backpressureThreshold: 1 },
    });
    const dispatcher = new FakeDispatcher();
    const item = makeTriageItem();
    const approved = makeIssue({ labels: [], comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const proposed = [makeIssue(), makeIssue()];
    const linear = new FakeLinear([approved], proposed);
    const ctx = makeContext({ config, linear, dispatcher });

    const report = await runIntakeTick(ctx);

    expect(report.skipReason).toContain("backpressure");
    expect(report.applyPassRan).toBe(true);
    expect(report.appliedCount).toBe(1);
  });

  it("reports the applied count and identifiers for multiple approved proposals", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const first = makeIssue({ labels: [], comments: [proposalComment(makeTriageItem(), "2026-01-01T00:00:00.000Z")] });
    const second = makeIssue({ labels: [], comments: [proposalComment(makeTriageItem(), "2026-01-01T00:00:00.000Z")] });
    const linear = new FakeLinear([first, second], []);
    const messages: string[] = [];
    const ctx = makeContext({ config, linear, dispatcher, log: (message) => messages.push(message) });

    const report = await runIntakeTick(ctx);

    expect(report.appliedCount).toBe(2);
    expect(messages.some((message) => message.includes(first.identifier) && message.includes(second.identifier))).toBe(true);
  });

  it("logs the zero case when no approvals are pending", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const linear = new FakeLinear([makeIssue()], []);
    const messages: string[] = [];
    const ctx = makeContext({ config, linear, dispatcher, log: (message) => messages.push(message) });

    const report = await runIntakeTick(ctx);

    expect(report.appliedCount).toBe(0);
    expect(messages.some((message) => message.includes("no approvals pending"))).toBe(true);
  });

  it("still saves bookkeeping when applying a proposal fails", async () => {
    const config = makeConfig();
    const dispatcher = new FakeDispatcher();
    const item = makeTriageItem();
    const approved = makeIssue({ labels: [], comments: [proposalComment(item, "2026-01-01T00:00:00.000Z")] });
    const brokenLinear = new FakeLinear([approved], []);
    brokenLinear.updateIssue = async () => {
      throw new Error("Linear 4xx");
    };
    const messages: string[] = [];
    const ctx = makeContext({ config, linear: brokenLinear, dispatcher, log: (message) => messages.push(message) });

    const report = await runIntakeTick(ctx);

    expect(messages.some((message) => message.includes("apply pass: failed to apply"))).toBe(true);
    expect(report.ranAt).toBe(ctx.now().toISOString());
  });
});

// ---- lock ---------------------------------------------------------------

describe("SupervisorLock — intake singleton (SPEC §3.12)", () => {
  it("refuses a second acquire while a live holder's pid is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-intake-lock-"));
    const lockPath = join(dir, "intake.lock");
    const lock = new SupervisorLock(lockPath);
    const probe = { isAlive: (_pid: number) => true };

    lock.acquire(process.pid, new Date(), probe);
    expect(existsSync(lockPath)).toBe(true);

    const second = new SupervisorLock(lockPath);
    expect(() => second.acquire(process.pid + 1, new Date(), probe)).toThrow(/already running/);

    lock.release();
  });

  it("takes over a stale lock whose holder pid is dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-intake-lock-"));
    const lockPath = join(dir, "intake.lock");
    const deadProbe = { isAlive: (_pid: number) => false };

    const first = new SupervisorLock(lockPath);
    first.acquire(999_999, new Date(), deadProbe);

    const second = new SupervisorLock(lockPath);
    expect(() => second.acquire(process.pid, new Date(), deadProbe)).not.toThrow();

    second.release();
  });
});

// ---- repo lookup (SPEC §3.12) ------------------------------------------

describe("repoEntryForIssue — registry lookup without filesystem scanning (SPEC §3.12)", () => {
  it("resolves the repo entry when the issue's project's initiative is bound in the registry", async () => {
    const config = makeConfig({
      repos: {
        plotroom: { path: "/repos/plotroom", initiatives: ["init-1"] },
      },
    });
    const linear = new FakeLinear([], [], async () => ({ id: "init-1", name: "Plotroom Fleet" }));
    const issue = makeIssue({ project: { id: "proj-1", name: "Project" } });

    const entry = await repoEntryForIssue(linear, { "init-1": "plotroom" }, config, issue);

    expect(entry?.alias).toBe("plotroom");
    expect(entry?.repoPath).toBe("/repos/plotroom");
  });

  it("still returns null (processed without repro) when the initiative is bound to no registry entry", async () => {
    const config = makeConfig();
    const linear = new FakeLinear([], [], async () => ({ id: "init-orphan", name: "Unbound Initiative" }));
    const issue = makeIssue({ project: { id: "proj-1", name: "Project" } });

    const entry = await repoEntryForIssue(linear, {}, config, issue);

    expect(entry).toBeNull();
  });

  it("returns null without calling Linear when the issue has no project", async () => {
    const config = makeConfig();
    const linear = new FakeLinear([], []);
    const issue = makeIssue({ project: null });

    const entry = await repoEntryForIssue(linear, {}, config, issue);

    expect(entry).toBeNull();
  });
});
