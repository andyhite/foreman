import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "@foreman/core";
import { encodeMarker, FOREMAN_LABEL, GitHubClient, groupDisplayName, labelDisplayName, MARKER_KIND, renderLockComment } from "@foreman/core";
import type { Comment, Issue, IssueLabel, ResolvedRepoEntry, WorkflowState } from "@foreman/core";
import { FakeLinear } from "./fake-linear.ts";
import { reconcile, type ReconcileContext } from "../src/reconcile.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_PROGRESS: WorkflowState = { id: "state-in-progress", name: "In Progress", type: "started", position: 3 };
const STATE_IN_REVIEW: WorkflowState = { id: "state-in-review", name: "In Review", type: "started", position: 4 };
const STATE_DONE: WorkflowState = { id: "state-done", name: "Done", type: "completed", position: 5 };

/** `id` keeps the canonical colon-form (what `removeForemanLabel` matches on); `name`/`parentId` mirror the display-name/group-name pair `FakeLinear`'s filter matcher expects, the same shape `LinearClient` reconstructs from the wire. */
function label(canonicalId: string): IssueLabel {
  const colon = canonicalId.indexOf(":");
  const name = colon === -1 ? labelDisplayName(canonicalId) : labelDisplayName(canonicalId.slice(colon + 1));
  const parentId = colon === -1 ? null : groupDisplayName(canonicalId.slice(0, colon));
  return { id: canonicalId, name, parentId };
}

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
    state: STATE_TODO,
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
    initiativeIds: ["initiative-1"],
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

function makeContext(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    linear: new FakeLinear([]),
    github: stubGitHub(() => ({ stdout: "" })),
    entry: makeEntry(),
    now: new Date("2026-06-01T12:00:00.000Z"),
    liveDispatchIds: new Set(),
    lockTtlMs: 7_200_000,
    confirmer: ALWAYS_APPROVE,
    ...overrides,
  };
}

describe("reconcile — stale-running", () => {
  it("removes an orphaned running label, moves a started issue to Todo, and comments", async () => {
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
    const issue = makeIssue({
      state: STATE_IN_PROGRESS,
      labels: [label(FOREMAN_LABEL.running)],
      comments: [lockComment],
    });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(issue.labels.some((l) => l.name === FOREMAN_LABEL.running)).toBe(false);
    expect(issue.state.id).toBe(STATE_TODO.id);
    expect(linear.commentCalls).toHaveLength(1);
    expect(linear.commentCalls[0]!.body).toContain("released orphaned lock");
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });

  it("a declined confirmation counts as skipped and performs no mutation", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, labels: [label(FOREMAN_LABEL.running)], comments: [] });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear, confirmer: ALWAYS_DENY });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(issue.labels.some((l) => l.id === FOREMAN_LABEL.running)).toBe(true);
    expect(linear.updateCalls).toHaveLength(0);
  });
});

describe("reconcile — in-progress-abandoned", () => {
  it("moves to In Review when an open PR exists for the branch", async () => {
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

  it("moves to Todo when no PR exists for the branch", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, labels: [], comments: [] });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.state.id).toBe(STATE_TODO.id);
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
});

describe("reconcile — in-review-no-pr", () => {
  it("moves to Todo when there is no PR and the branch was never pushed", async () => {
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
    expect(issue.state.id).toBe(STATE_TODO.id);
  });
});

describe("reconcile — blocked-answered", () => {
  it("removes the blocked label and writes an unblock marker once the operator has replied", async () => {
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
      state: STATE_TODO,
      labels: [label(FOREMAN_LABEL.blocked)],
      comments: [blockComment, replyComment],
    });
    const linear = new FakeLinear([issue]);
    const ctx = makeContext({ linear });

    const summary = await reconcile(ctx, { dryRun: false, log: () => {} });

    expect(summary.fixed).toBe(1);
    expect(issue.labels.some((l) => l.name === FOREMAN_LABEL.blocked)).toBe(false);
    expect(linear.commentCalls.some((call) => call.body.includes("auto: answered in comment reply-1"))).toBe(true);
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
  });
});

describe("reconcile — dry run", () => {
  it("logs every fix without mutating or confirming", async () => {
    const issue = makeIssue({ state: STATE_IN_PROGRESS, labels: [label(FOREMAN_LABEL.running)], comments: [] });
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
