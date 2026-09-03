import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "@foreman/core";
import { encodeMarker, GitHubClient, MARKER_KIND } from "@foreman/core";
import type { Comment, Issue, ResolvedRepoEntry, ReviewResult, WorkflowState } from "@foreman/core";
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

/** `FakeLinear.viewerId()` is pinned to `"viewer-1"`; default the marker's author to match unless a test wants an authorship mismatch. */
function reviewMarkerComment(
  reviewedSha: string,
  verdict: "approve" | "request-changes" | "comment",
  overrides: Partial<ReviewResult> = {},
  authorId = "viewer-1",
): Comment {
  const data: ReviewResult = {
    issueId: "ENG-1",
    reviewedSha,
    criteriaVerification: [{ criterion: "Works", satisfied: true, evidence: "file.ts:1" }],
    dodSatisfied: true,
    dodChecklist: [],
    findings: [],
    projectOrganization: "no concerns",
    scopeCreep: [],
    testAdequacy: "would fail if reverted",
    verdict,
    ...overrides,
  };
  return {
    id: `comment-review-${authorId}-${reviewedSha}`,
    body: encodeMarker(MARKER_KIND.review, data, "Reviewed."),
    createdAt: "2026-06-01T12:00:00.000Z",
    user: { id: authorId, name: authorId, displayName: authorId },
    parentId: null,
  };
}

function makeCtx(
  linear: FakeLinear,
  github: GitHubClient,
  entry: ResolvedRepoEntry,
  configOverrides: { autoMerge?: boolean; retryCap?: number; reviewCycleCap?: number } = {},
): LoopContext {
  return {
    linear,
    github,
    entry,
    config: {
      loop: {
        autoMerge: configOverrides.autoMerge ?? false,
        retryCap: configOverrides.retryCap ?? 2,
        reviewCycleCap: configOverrides.reviewCycleCap ?? 2,
      },
    } as unknown as LoopContext["config"],
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  };
}

function openPrGithub(headSha: string): GitHubClient {
  return stubGitHub((argv) => {
    if (argv.includes("list")) {
      return {
        stdout: JSON.stringify([
          {
            number: 1,
            url: "https://github.com/acme/repo/pull/1",
            headRefOid: headSha,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            baseRefName: "main",
          },
        ]),
      };
    }
    if (argv.some((a) => a.includes("check-runs"))) {
      return { stdout: JSON.stringify([{ check_runs: [{ status: "completed", conclusion: "success" }] }]) };
    }
    return { stdout: "" };
  });
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

  it("returns two eligible Todo issues highest-priority-first", async () => {
    const entry = makeEntry();
    const low = makeIssue({ id: "issue-low", identifier: "ENG-2", priority: 4, createdAt: "2026-01-01T00:00:00.000Z" });
    const high = makeIssue({ id: "issue-high", identifier: "ENG-3", priority: 1, createdAt: "2026-01-02T00:00:00.000Z" });
    const linear = new FakeLinear([low, high]);
    const github = stubGitHub(() => ({ stdout: "" }));
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const implementRule = BUILD_LOOP.rules.find((rule) => rule.name === "implement")!;
    const candidates = implementRule.select(snapshot);

    expect(candidates.map((c) => c.subject)).toEqual(["ENG-3", "ENG-2"]);
  });
});

describe("BUILD_LOOP — review rule", () => {
  it("does not propose a review candidate for an issue already reviewed at head", async () => {
    const entry = makeEntry();
    const issue = makeIssue({ state: STATE_IN_REVIEW, comments: [reviewMarkerComment("sha-head", "approve")] });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-head");
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    expect(reviewRule.select(snapshot)).toHaveLength(0);
  });

  it("proposes a review candidate when the PR head has moved past the last reviewed sha", async () => {
    const entry = makeEntry();
    const issue = makeIssue({ state: STATE_IN_REVIEW, comments: [reviewMarkerComment("sha-old", "approve")] });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-new");
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;

    expect(reviewRule.select(snapshot)).toHaveLength(1);
    expect(mergeRule.select(snapshot)).toHaveLength(0);
  });

  it("ignores a review marker authored by someone other than the loop's own viewer, and still proposes re-review", async () => {
    const entry = makeEntry();
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [reviewMarkerComment("sha-head", "approve", {}, "some-other-user")],
    });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-head");
    const ctx = makeCtx(linear, github, entry);

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    expect(reviewRule.select(snapshot)).toHaveLength(1);
  });

  it("stops proposing review once requestChangesCycles reaches reviewCycleCap, and escalates instead", async () => {
    const entry = makeEntry();
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [
        reviewMarkerComment("sha-1", "request-changes"),
        reviewMarkerComment("sha-2", "request-changes"),
      ],
    });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-3");
    const ctx = makeCtx(linear, github, entry, { reviewCycleCap: 2 });

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    expect(reviewRule.select(snapshot)).toHaveLength(0);

    const escalations = BUILD_LOOP.escalations?.(snapshot, ctx) ?? [];
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.kind).toBe("review-cycle-exhausted");
    expect(escalations[0]?.issueId).toBe("ENG-1");
  });
});

describe("BUILD_LOOP — merge rule", () => {
  it("proposes no merge candidate when loop.autoMerge is false, even for an otherwise-mergeable issue", async () => {
    const entry = makeEntry();
    const issue = makeIssue({ state: STATE_IN_REVIEW, comments: [reviewMarkerComment("sha-head", "approve")] });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-head");
    const ctx = makeCtx(linear, github, entry, { autoMerge: false });

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;
    expect(mergeRule.select(snapshot)).toHaveLength(0);
  });

  it("proposes a merge candidate when loop.autoMerge is true and the review gate passes", async () => {
    const entry = makeEntry();
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [reviewMarkerComment("sha-head", "approve", { dodSatisfied: true, findings: [] })],
    });
    const linear = new FakeLinear([issue]);
    const github = openPrGithub("sha-head");
    const ctx = makeCtx(linear, github, entry, { autoMerge: true });

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;
    const candidates = mergeRule.select(snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agent).toBe("foreman-merge");
    expect(candidates[0]?.command).toBe("/foreman:merge");
  });

  it("proposes no merge candidate when loop.autoMerge is true but CI is pending", async () => {
    const entry = makeEntry({ pr: { required: true, draft: false, ciRequired: true } });
    const issue = makeIssue({ state: STATE_IN_REVIEW, comments: [reviewMarkerComment("sha-head", "approve")] });
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
      if (argv.some((a) => a.includes("check-runs"))) {
        return { stdout: JSON.stringify([{ check_runs: [{ status: "in_progress", conclusion: null }] }]) };
      }
      return { stdout: "" };
    });
    const ctx = makeCtx(linear, github, entry, { autoMerge: true });

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;
    expect(mergeRule.select(snapshot)).toHaveLength(0);
  });

  it("direct-branch mode: resolves the head SHA via revParse, merges when autoMerge and pinned review match, and does not re-propose review", async () => {
    const entry = makeEntry({ pr: { required: false, draft: false, ciRequired: false } });
    const issue = makeIssue({
      state: STATE_IN_REVIEW,
      comments: [reviewMarkerComment("sha-direct", "approve", { dodSatisfied: true, findings: [] })],
    });
    const linear = new FakeLinear([issue]);
    const github = stubGitHub((argv) => {
      if (argv.includes("rev-parse")) return { stdout: "sha-direct\n" };
      return { stdout: "" };
    });
    const ctx = makeCtx(linear, github, entry, { autoMerge: true });

    const snapshot = await BUILD_LOOP.fetch(ctx);
    const reviewRule = BUILD_LOOP.rules.find((rule) => rule.name === "review")!;
    const mergeRule = BUILD_LOOP.rules.find((rule) => rule.name === "merge")!;

    expect(reviewRule.select(snapshot)).toHaveLength(0);
    expect(mergeRule.select(snapshot)).toHaveLength(1);
  });
});
