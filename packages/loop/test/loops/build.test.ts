import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "@foreman/core";
import { encodeMarker, GitHubClient, MARKER_KIND } from "@foreman/core";
import type { Comment, Issue, ResolvedRepoEntry, WorkflowState } from "@foreman/core";
import { BUILD_LOOP } from "../../src/loops/build.ts";
import type { LoopContext } from "../../src/engine.ts";
import { FakeLinear } from "../fake-linear.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_IN_REVIEW: WorkflowState = { id: "state-in-review", name: "In Review", type: "started", position: 4 };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: "## Acceptance Criteria\n- [ ] Works",
    priority: 3,
    estimate: 2,
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
    branchPattern: "<issue-id>-<slug>",
    worktreePattern: "../<repo>-<ISSUE-ID>",
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

function reviewMarkerComment(reviewedSha: string, verdict: "approve" | "request-changes"): Comment {
  return {
    id: "comment-review",
    body: encodeMarker(MARKER_KIND.review, { issueId: "ENG-1", reviewedSha, verdict, notes: "" }, "Reviewed."),
    createdAt: "2026-06-01T12:00:00.000Z",
    user: { id: "bot-1", name: "bot-1", displayName: "bot-1" },
    parentId: null,
  };
}

function makeCtx(linear: FakeLinear, github: GitHubClient, entry: ResolvedRepoEntry): LoopContext {
  return {
    linear,
    github,
    entry,
    config: {} as LoopContext["config"],
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  };
}

describe("BUILD_LOOP — implement rule", () => {
  it("proposes an implement candidate for an unblocked, unassigned Todo issue", async () => {
    const entry = makeEntry();
    const linear = new FakeLinear([makeIssue()]);
    const github = stubGitHub(() => ({ stdout: "" }));
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const implementRule = BUILD_LOOP.rules.find((rule) => rule.name === "implement")!;
    const candidates = implementRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agent).toBe("foreman-implement");
    expect(candidates[0]?.subject).toBe("ENG-1");
  });

  it("does not propose an implement candidate for a Todo issue with an incomplete blocker", async () => {
    const entry = makeEntry();
    const blockerIssue = makeIssue({
      id: "issue-1",
      identifier: "ENG-1",
      relations: [
        {
          id: "rel-1",
          type: "blocks",
          direction: "incoming",
          other: { id: "issue-2", identifier: "ENG-2", title: "Blocker", state: STATE_TODO },
        },
      ],
    });
    const linear = new FakeLinear([blockerIssue]);
    const github = stubGitHub(() => ({ stdout: "" }));
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const implementRule = BUILD_LOOP.rules.find((rule) => rule.name === "implement")!;
    expect(implementRule.select(snapshot)).toHaveLength(0);
  });
});

describe("BUILD_LOOP — review and merge rules", () => {
  it("does not propose a review candidate for an issue already reviewed at head, but does propose merge when approved", async () => {
    const entry = makeEntry();
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [reviewMarkerComment("sha-head", "approve")],
    });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
              headRefOid: "sha-head",
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              baseRefName: "main",
            },
          ]),
        };
      }
      return { stdout: "" };
    });
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;

    expect(reviewRule.select(snapshot)).toHaveLength(0);
    const mergeCandidates = mergeRule.select(snapshot);
    expect(mergeCandidates).toHaveLength(1);
    expect(mergeCandidates[0]?.agent).toBe("foreman-merge");
    expect(mergeCandidates[0]?.command).toBe("/foreman:merge");
  });

  it("proposes a review candidate when the PR head has moved past the last reviewed sha", async () => {
    const entry = makeEntry();
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [reviewMarkerComment("sha-old", "approve")],
    });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              number: 1,
              url: "https://github.com/acme/repo/pull/1",
              headRefOid: "sha-new",
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              baseRefName: "main",
            },
          ]),
        };
      }
      return { stdout: "" };
    });
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;

    expect(reviewRule.select(snapshot)).toHaveLength(1);
    expect(mergeRule.select(snapshot)).toHaveLength(0);
  });
});
