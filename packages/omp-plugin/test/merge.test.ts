import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER_KIND, PRIORITY, TYPE_LABEL, encodeMarker, ensureWorktree, worktreePathFor } from "@foreman/core";
import type { Comment, CommandRunner, CreateIssueInput, Issue, IssueLabel, IssueMutation, LinearWriter, MergedRecord, Project, ProjectRef, ResolvedRepoEntry, WorkflowState } from "@foreman/core";
import { GitHubClient } from "@foreman/core";
import { runMerge } from "../src/commands/merge.ts";

const STATE_IN_REVIEW: WorkflowState = {
  id: "state-in-review",
  name: "In Review",
  type: "started",
  position: 4,
};
const STATE_DONE: WorkflowState = { id: "state-done", name: "Done", type: "completed", position: 5 };

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
    state: STATE_IN_REVIEW,
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

class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
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
  async project(_projectId: string): Promise<Project | null> {
    return { id: "project-1", name: "Foreman", description: null, content: null, startDate: null, targetDate: null, status: null, documents: [] };
  }
  async projectStatus() {
    return null;
  }
  async projectInitiatives(projectId: string) {
    return this.initiativesByProject.get(projectId) ?? [{ id: "initiative-1", name: "Foreman" }];
  }
  async projectInitiative(projectId: string) {
    const refs = await this.projectInitiatives(projectId);
    return refs[0] ?? { id: "initiative-1", name: "Foreman" };
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
    return [STATE_IN_REVIEW, STATE_DONE];
  }
  async labels() {
    return [];
  }
  async teams() {
    return [{ id: "team-1", key: "ENG", name: "Engineering" }];
  }
  async projects() {
    return [{ id: "project-1", name: "Foreman" }];
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = [...this.issuesById.values()].find((candidate) => candidate.id === id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
    if (input.stateId) {
      issue.state = input.stateId === STATE_DONE.id ? STATE_DONE : issue.state;
    }
    return issue;
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not implemented");
  }
  async createProject(input: {
    name: string;
    teamIds: string[];
    description?: string;
    content?: string;
  }): Promise<ProjectRef> {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
  async updateProjectStatus() {}
  async createComment(input: { issueId: string; body: string; parentId?: string }): Promise<Comment> {
    return {
      id: `comment-${input.issueId}`,
      body: input.body,
      createdAt: new Date().toISOString(),
      user: null,
      parentId: input.parentId ?? null,
    };
  }
  async createRelation() {}
  async deleteRelation() {}
  async projectRelations() {
    return [];
  }
  async createProjectRelation() {}
  async deleteProjectRelation() {}
  async createLabel(input: {
    name: string;
    teamId?: string;
    isGroup?: boolean;
    parentId?: string;
    color?: string;
    description?: string;
  }): Promise<IssueLabel> {
    return label(input.name);
  }
  async ensureLabel(name: string, _teamId: string): Promise<IssueLabel> {
    return label(name);
  }
}

function reviewComment(headSha: string) {
  return encodeMarker(
    MARKER_KIND.review,
    {
      issueId: "ENG-1",
      reviewedSha: headSha,
      criteriaVerification: [{ criterion: "Does the thing", satisfied: true, evidence: "src/foo.ts:1" }],
      dodSatisfied: true,
      dodChecklist: [{ item: "Tests pass", satisfied: true, evidence: "bun test" }],
      findings: [],
      projectOrganization: "No concerns.",
      scopeCreep: [],
      testAdequacy: "Adequate.",
      summary: "Looks good.",
    },
    "review ok",
  );
}

function stubRunner(respond: (argv: string[]) => { stdout: string }): CommandRunner {
  return {
    run(argv) {
      return Promise.resolve({ stdout: respond(argv).stdout, stderr: "", code: 0 });
    },
  };
}

const entry: ResolvedRepoEntry = {
  alias: "test",
  repoPath: "/repo",
  team: "ENG",
  initiativeIds: ["initiative-1"],
  baseBranch: "main",
  pr: { required: true, draft: false, ciRequired: false },
  merge: { strategy: "squash", deleteBranch: true },
  branchPattern: "<issue-id>-<slug>",
  worktreePattern: "../<repo>-<ISSUE-ID>",
};

describe("runMerge — partial failure recovery", () => {
  it("reports a loud error when git merge succeeds but Linear cannot move to Done, then finishes on re-run", async () => {
    const headSha = "abc123";
    const issue = makeIssue({
      comments: [
        {
          id: "c-review",
          body: reviewComment(headSha),
          createdAt: "2026-01-01T00:00:00.000Z",
          user: { id: "bot-1", name: "Bot", displayName: "Bot" },
          parentId: null,
        },
      ],
    });
    const linear = new FakeLinear([issue]);
    let mergeCalls = 0;
    const github = new GitHubClient({
      runner: stubRunner((argv) => {
        if (argv.includes("pr") && argv.includes("list")) {
          const stateFlag = argv[argv.indexOf("--state") + 1];
          if (stateFlag === "all" && mergeCalls > 0) {
            return {
              stdout: JSON.stringify([
                {
                  number: 7,
                  url: "https://github.com/org/repo/pull/7",
                  headRefOid: headSha,
                  state: "MERGED",
                  isDraft: false,
                  mergeable: "MERGEABLE",
                  baseRefName: "main",
                },
              ]),
            };
          }
          return {
            stdout: JSON.stringify([
              {
                number: 7,
                url: "https://github.com/org/repo/pull/7",
                headRefOid: headSha,
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                baseRefName: "main",
              },
            ]),
          };
        }
        if (argv.includes("pr") && argv.includes("merge")) {
          mergeCalls += 1;
          return { stdout: "" };
        }
        if (argv.includes("check-runs")) {
          return { stdout: JSON.stringify([{ check_runs: [] }]) };
        }
        if (argv.includes("api")) {
          return { stdout: JSON.stringify([{ check_runs: [] }]) };
        }
        return { stdout: "[]" };
      }),
    });

    let updateAttempts = 0;
    const flakyLinear: LinearWriter = new Proxy(linear, {
      get(target, prop, receiver) {
        if (prop === "updateIssue") {
          return async (id: string, input: IssueMutation) => {
            updateAttempts += 1;
            if (updateAttempts === 1) throw new Error("Linear API unavailable");
            return target.updateIssue(id, input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const first = await runMerge(flakyLinear, github, "ENG-1", entry);
    expect(first.merged).toBe(false);
    expect(first.message).toContain("PR #7 merged");
    expect(first.message).toContain("could NOT be moved to Done");
    expect(first.message).toContain("/foreman:merge ENG-1");
    expect(mergeCalls).toBe(1);
    expect((await flakyLinear.issue("ENG-1"))?.state.id).toBe(STATE_IN_REVIEW.id);

    const second = await runMerge(flakyLinear, github, "ENG-1", entry);
    expect(second.merged).toBe(true);
    expect(second.message).toContain("already complete");
    expect(mergeCalls).toBe(1);
    expect((await flakyLinear.issue("ENG-1"))?.state.id).toBe(STATE_DONE.id);
  });
});

describe("runMerge — worktree cleanup (SPEC §12)", () => {
  let repoRoot: string;
  let directBranchRepoPath: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "foreman-merge-cleanup-")));
    directBranchRepoPath = join(repoRoot, "repo");
    execFileSync("git", ["init", "--initial-branch=main", directBranchRepoPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directBranchRepoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directBranchRepoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: directBranchRepoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function mergedMarkerComment(issue: Issue, entry: ResolvedRepoEntry) {
    const record: MergedRecord = {
      issueId: issue.identifier,
      branch: issue.branchName,
      baseBranch: entry.baseBranch,
      mergeCommit: "deadbeef",
      strategy: "squash",
      mergedAt: "2026-06-01T00:00:00.000Z",
    };
    return {
      id: "comment-merged",
      body: encodeMarker(MARKER_KIND.merged, record, "Merged."),
      createdAt: "2026-06-01T00:00:00.000Z",
      user: { id: "bot-1", name: "bot", displayName: "bot" },
      parentId: null,
    };
  }

  it("removes the issue's clean worktree and reports it in the result message", async () => {
    const directEntry: ResolvedRepoEntry = { ...entry, repoPath: directBranchRepoPath, pr: { required: false, draft: false, ciRequired: false } };
    const issue = makeIssue({ comments: [] });
    issue.comments = [mergedMarkerComment(issue, directEntry)];
    const worktreePath = worktreePathFor(directEntry.worktreePattern, directBranchRepoPath, issue);
    await ensureWorktree({ repoPath: directBranchRepoPath, worktreePath, branch: "wt-branch", baseBranch: "main" });
    const linear = new FakeLinear([issue]);
    const github = new GitHubClient({ runner: stubRunner(() => ({ stdout: "[]" })) });

    const result = await runMerge(linear, github, "ENG-1", directEntry);

    expect(result.merged).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("leaves a dirty worktree in place and notes it in the result message", async () => {
    const directEntry: ResolvedRepoEntry = { ...entry, repoPath: directBranchRepoPath, pr: { required: false, draft: false, ciRequired: false } };
    const issue = makeIssue({ comments: [] });
    issue.comments = [mergedMarkerComment(issue, directEntry)];
    const worktreePath = worktreePathFor(directEntry.worktreePattern, directBranchRepoPath, issue);
    await ensureWorktree({ repoPath: directBranchRepoPath, worktreePath, branch: "wt-branch", baseBranch: "main" });
    writeFileSync(join(worktreePath, "scratch.txt"), "wip");
    const linear = new FakeLinear([issue]);
    const github = new GitHubClient({ runner: stubRunner(() => ({ stdout: "[]" })) });

    const result = await runMerge(linear, github, "ENG-1", directEntry);

    expect(result.merged).toBe(true);
    expect(result.message).toContain("uncommitted changes");
    expect(existsSync(worktreePath)).toBe(true);
  });
});
