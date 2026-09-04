import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "@foreman/core";
import { encodeMarker, GitHubClient, MARKER_KIND, renderLockComment } from "@foreman/core";
import type { Comment, GlobalConfig, Issue, ResolvedRepoEntry, WorkflowState } from "@foreman/core";
import { FakeLinear } from "./fake-linear.ts";
import { reconcile, type ReconcileContext } from "../src/reconcile.ts";

const STATE_BACKLOG: WorkflowState = { id: "state-backlog", name: "Backlog", type: "backlog", position: 0 };
const STATE_REFINING: WorkflowState = { id: "state-refining", name: "Refining", type: "started", position: 1 };
const STATE_READY: WorkflowState = { id: "state-ready", name: "Ready", type: "unstarted", position: 3 };
const STATE_IN_PROGRESS: WorkflowState = { id: "state-in-progress", name: "In Progress", type: "started", position: 5 };
const STATE_NEEDS_INPUT: WorkflowState = { id: "state-needs-input", name: "Needs Input", type: "unstarted", position: 2 };
const STATE_BLOCKED: WorkflowState = { id: "state-blocked", name: "Blocked", type: "started", position: 4 };
const STATE_IN_REVIEW: WorkflowState = { id: "state-in-review", name: "In Review", type: "started", position: 6 };
const STATE_DONE: WorkflowState = { id: "state-done", name: "Done", type: "completed", position: 7 };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: null,
    priority: 3,
    estimate: null,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_READY,
    labels: [],
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

function makeEntry(overrides: Partial<ResolvedRepoEntry> = {}): ResolvedRepoEntry {
  return {
    alias: "acme",
    repoPath: "/repos/acme",
    team: "ENG",
    apps: [],
    appNames: [],
    baseBranch: "main",
    pr: { required: true, draft: false, ciRequired: true },
    merge: { strategy: "squash", deleteBranch: true },
    branchPattern: "{identifier}-{slug}",
    worktreePattern: "{repo}-{identifier}",
    ...overrides,
  };
}

function stubGitHub(respond: (argv: string[]) => { stdout: string; code?: number }): GitHubClient {
  const runner: CommandRunner = {
    run(argv) {
      const result = respond(argv);
      if ((result.code ?? 0) !== 0) return Promise.reject(new Error(`command failed: ${argv.join(" ")}`));
      return Promise.resolve({ stdout: result.stdout, stderr: "", code: result.code ?? 0 });
    },
  };
  return new GitHubClient({ runner });
}

/** A lock comment well within TTL, so `in-progress-abandoned` (which also matches any unlabeled "started"-type issue with no recent lock) leaves the issue to the invariant actually under test. */
function recentLockComment(): Comment {
  return {
    id: "lock-recent",
    body: renderLockComment({
      dispatchId: "foreman-review-ENG-1-20260601T110000Z-def456",
      agent: "foreman-review",
      issueId: "ENG-1",
      takenAt: "2026-06-01T11:00:00.000Z",
      ttlMs: 7_200_000,
      worktree: null,
      released: false,
      releasedAt: null,
    }),
    createdAt: "2026-06-01T11:00:00.000Z",
    user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
    parentId: null,
  };
}

const ALWAYS_APPROVE = { confirm: async () => true, close: () => {} };
const ALWAYS_DENY = { confirm: async () => false, close: () => {} };

function makeConfig(): GlobalConfig {
  return {
    repos: {},
    loop: {
      mode: "yolo",
      cleanupMergedWorktrees: true,
      autoMerge: false,
      retryCap: 2,
      reviewCycleCap: 2,
      stateDir: "~/.foreman/state",
      concurrency: { plan: 1, build: 3 },
      pollSeconds: 20,
      triageBatch: 10,
    },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql", allowCustomEndpoint: false, operatorUserId: null },
    githubApp: { appId: null, privateKeyFile: null },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr", dispatcher: "auto" },
  } as GlobalConfig;
}

function makeContext(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    linear: new FakeLinear([]),
    github: stubGitHub(() => ({ stdout: "" })),
    entry: makeEntry(),
    now: new Date("2026-06-01T12:00:00.000Z"),
    liveDispatchIds: new Set(),
    lockTtlMs: 7_200_000,
    confirmer: ALWAYS_APPROVE,
    viewerId: null,
    config: makeConfig(),
    ...overrides,
  };
}

describe("reconcile — stale-running", () => {
  it("moves an orphaned Refining issue to Ready, clears the assignee, and comments", async () => {
    const lockComment: Comment = {
      id: "c1",
      body: renderLockComment({
        dispatchId: "foreman-implement-ENG-1-20260101T000000Z-abc123",
        agent: "foreman-implement",
        issueId: "ENG-1",
        takenAt: "2026-01-01T00:00:00.000Z",
        ttlMs: 7_200_000,
        worktree: null,
        released: false,
        releasedAt: null,
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
      parentId: null,
    };
    const issue = makeIssue({ state: STATE_REFINING, comments: [lockComment] });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(issue.state.id).toBe(STATE_READY.id);
    expect(linear.commentCalls).toHaveLength(1);
    expect(linear.commentCalls[0]!.body).toContain("released orphaned lock");
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("a declined confirmation counts as skipped and performs no mutation", async () => {
    const issue = makeIssue({ state: STATE_REFINING, comments: [] });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear, confirmer: ALWAYS_DENY });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(issue.state.id).toBe(STATE_REFINING.id);
    expect(linear.updateCalls).toHaveLength(0);
  });
});

describe("reconcile — in-progress-abandoned", () => {
  it("routes an abandoned In Progress issue with an open PR to In Review (stale-running no longer preempts it — it covers Refining only)", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, labels: [], comments: [] });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            { number: 1, url: "https://github.com/acme/repo/pull/1", headRefOid: "abc", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" },
          ]),
        };
      }
      if (argv.includes("view")) return { stdout: JSON.stringify({ state: "OPEN" }) };
      return { stdout: "" };
    });
    const ctx = makeContext({ linear, github });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_IN_REVIEW.id);
  });

  it("moves to Ready when no PR exists for the branch", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, labels: [], comments: [] });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_READY.id);
  });

  it("leaves a self-assigned (hands-off) In Progress issue with no lock comment alone — notHandsOff must exclude it at the query level", async () => {
    const issue = makeIssue({
      state: STATE_IN_PROGRESS,
      labels: [],
      comments: [],
      assignee: { id: "human-operator", name: "Operator", displayName: "Operator" },
      updatedAt: "2026-06-01T11:59:50.000Z",
    });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(issue.state.id).toBe(STATE_IN_PROGRESS.id);
    expect(issue.assignee?.id).toBe("human-operator");
    expect(linear.updateCalls).toHaveLength(0);
  });
});

describe("reconcile — merged-not-done", () => {
  it("moves an In Review issue to Done once its PR is merged", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW, labels: [], comments: [recentLockComment()] });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            { number: 1, url: "https://github.com/acme/repo/pull/1", headRefOid: "abc", state: "MERGED", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" },
          ]),
        };
      }
      if (argv.includes("view")) return { stdout: JSON.stringify({ state: "MERGED" }) };
      return { stdout: "" };
    });
    const ctx = makeContext({ linear, github });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_DONE.id);
  });

  it("leaves a merged In Review issue assigned to a non-viewer alone", async () => {
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      labels: [],
      comments: [],
      assignee: { id: "human-operator", name: "Operator", displayName: "Operator" },
    });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            { number: 1, url: "https://github.com/acme/repo/pull/1", headRefOid: "abc", state: "MERGED", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main" },
          ]),
        };
      }
      if (argv.includes("view")) return { stdout: JSON.stringify({ state: "MERGED" }) };
      return { stdout: "" };
    });
    const ctx = makeContext({ linear, github, viewerId: "bot-1" });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(issue.state.id).toBe(STATE_IN_REVIEW.id);
    expect(linear.updateCalls).toHaveLength(0);
  });
});

describe("reconcile — in-review-no-pr", () => {
  it("moves to Ready when there is no PR and the branch was never pushed", async () => {
    const issue = makeIssue({ state: STATE_IN_REVIEW, labels: [], comments: [recentLockComment()] });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) return { stdout: "" };
      if (argv.includes("rev-parse")) return { stdout: "", code: 1 };
      return { stdout: "" };
    });
    const ctx = makeContext({ linear, github });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_READY.id);
  });
});

describe("reconcile — blocked-answered", () => {
  it("moves a Needs Input issue to Backlog and writes an unblock marker once the operator has replied", async () => {
    const blockComment: Comment = {
      id: "block-1",
      body: encodeMarker(MARKER_KIND.block, { type: "needs-decision" }, "Need a decision"),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
      parentId: null,
    };
    const replyComment: Comment = {
      id: "reply-1",
      body: "Go ahead with option A.",
      createdAt: "2026-01-02T00:00:00.000Z",
      user: { id: "operator-1", name: "operator-1", displayName: "operator-1" },
      parentId: null,
    };
    const issue = makeIssue({
      state: STATE_NEEDS_INPUT,
      comments: [blockComment, replyComment],
    });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear, viewerId: "bot-1", config: { ...makeConfig(), linear: { ...makeConfig().linear, operatorUserId: "operator-1" } } });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_BACKLOG.id);
    expect(linear.commentCalls.some((call) => call.body.includes("auto: answered in comment reply-1"))).toBe(true);
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("moves a Blocked issue to Ready and writes an unblock marker once the operator has replied", async () => {
    const blockComment: Comment = {
      id: "block-2",
      body: encodeMarker(MARKER_KIND.block, { type: "needs-decision" }, "Need a decision"),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
      parentId: null,
    };
    const replyComment: Comment = {
      id: "reply-2",
      body: "Go ahead with option A.",
      createdAt: "2026-01-02T00:00:00.000Z",
      user: { id: "operator-1", name: "operator-1", displayName: "operator-1" },
      parentId: null,
    };
    const issue = makeIssue({
      state: STATE_BLOCKED,
      comments: [blockComment, replyComment],
    });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear, viewerId: "bot-1", config: { ...makeConfig(), linear: { ...makeConfig().linear, operatorUserId: "operator-1" } } });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_READY.id);
    expect(linear.commentCalls.some((call) => call.body.includes("auto: answered in comment reply-2"))).toBe(true);
  });

  it("does not select an issue whose only later comment is from a third user, once operatorUserId is configured", async () => {
    const blockComment: Comment = {
      id: "block-3",
      body: encodeMarker(MARKER_KIND.block, { type: "needs-decision" }, "Need a decision"),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
      parentId: null,
    };
    const thirdPartyComment: Comment = {
      id: "reply-3",
      body: "+1",
      createdAt: "2026-01-02T00:00:00.000Z",
      user: { id: "teammate-1", name: "teammate-1", displayName: "teammate-1" },
      parentId: null,
    };
    const issue = makeIssue({
      state: STATE_NEEDS_INPUT,
      comments: [blockComment, thirdPartyComment],
    });
    const linear = new FakeLinear([issue]);
    const config = makeConfig();
    config.linear.operatorUserId = "operator-1";
    const ctx = makeContext({ linear, viewerId: "bot-1", config });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(issue.state.id).toBe(STATE_NEEDS_INPUT.id);
  });

  it("does not select a Blocked issue with a non-operator reply when operatorUserId is unconfigured", async () => {
    const blockComment: Comment = {
      id: "block-4",
      body: encodeMarker(MARKER_KIND.block, { type: "needs-decision" }, "Need a decision"),
      createdAt: "2026-01-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
      parentId: null,
    };
    const teammateComment: Comment = {
      id: "reply-4",
      body: "Go ahead with option A.",
      createdAt: "2026-01-02T00:00:00.000Z",
      user: { id: "teammate-1", name: "teammate-1", displayName: "teammate-1" },
      parentId: null,
    };
    const issue = makeIssue({
      state: STATE_BLOCKED,
      comments: [blockComment, teammateComment],
    });
    const linear = new FakeLinear([issue]);
    const config = makeConfig();
    config.linear.operatorUserId = null;
    const ctx = makeContext({ linear, viewerId: "bot-1", config });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(issue.state.id).toBe(STATE_BLOCKED.id);
  });
});

describe("reconcile — dry run", () => {
  it("logs every fix without mutating or confirming", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, comments: [] });
    const linear = new FakeLinear([issue]);
    let confirmCalls = 0;
    const confirmer = { confirm: async () => { confirmCalls += 1; return true; }, close: () => {} };
    const logs: string[] = [];
    const ctx = makeContext({ linear, confirmer });

    const summary = await reconcile(ctx, { dryRun: true, log: (line) => logs.push(line) });

    expect(confirmCalls).toBe(0);
    expect(summary.fixed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(linear.updateCalls).toHaveLength(0);
    expect(logs.some((line) => line.includes("dry run"))).toBe(true);
  });
});
