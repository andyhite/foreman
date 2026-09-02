import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatcher, DispatchHandle, DispatchOutcome, DispatchStatus } from "../src/dispatch/types.ts";
import { cleanupMergedWork } from "../src/apply/cleanup.ts";
import { ensureWorktree, worktreePathFor } from "../src/git/worktree.ts";

class SpyDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  cleanupCalls: Array<{ issueId: string; repoPath: string }> = [];

  async dispatch(): Promise<DispatchHandle[]> {
    throw new Error("not used in these tests");
  }
  async status(): Promise<DispatchStatus> {
    throw new Error("not used in these tests");
  }
  async settle(): Promise<DispatchOutcome> {
    throw new Error("not used in these tests");
  }
  async available(): Promise<boolean> {
    return true;
  }
  async cleanup(issueId: string, repoPath: string): Promise<void> {
    this.cleanupCalls.push({ issueId, repoPath });
  }
}

describe("cleanupMergedWork", () => {
  let repoRoot: string;
  let repoPath: string;
  const worktreePattern = "../<repo>-<ISSUE-ID>";
  const issue = { identifier: "ENG-142", title: "Fix triage dedupe" };

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "foreman-cleanup-")));
    repoPath = join(repoRoot, "repo");
    execFileSync("git", ["init", "--initial-branch=main", repoPath], { encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, encoding: "utf8" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: repoPath, encoding: "utf8" });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("removes a clean, merged worktree", async () => {
    const worktreePath = worktreePathFor(worktreePattern, repoPath, issue);
    await ensureWorktree({ repoPath, worktreePath, branch: "eng-142-fix", baseBranch: "main" });

    const notes = await cleanupMergedWork({ repoPath, worktreePattern, baseBranch: "main", issue });

    expect(notes).toEqual([]);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("leaves a dirty worktree in place and reports why", async () => {
    const worktreePath = worktreePathFor(worktreePattern, repoPath, issue);
    await ensureWorktree({ repoPath, worktreePath, branch: "eng-142-fix", baseBranch: "main" });
    writeFileSync(join(worktreePath, "scratch.txt"), "wip");

    const notes = await cleanupMergedWork({ repoPath, worktreePattern, baseBranch: "main", issue });

    expect(notes).toEqual([expect.stringContaining("uncommitted changes")]);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("is a silent no-op when the worktree never existed", async () => {
    const notes = await cleanupMergedWork({ repoPath, worktreePattern, baseBranch: "main", issue });

    expect(notes).toEqual([]);
  });

  it("calls the dispatcher's cleanup hook with the issue id and repo path", async () => {
    const dispatcher = new SpyDispatcher();

    const notes = await cleanupMergedWork({ repoPath, worktreePattern, baseBranch: "main", issue, dispatcher });

    expect(notes).toEqual([]);
    expect(dispatcher.cleanupCalls).toEqual([{ issueId: "ENG-142", repoPath }]);
  });

  it("reports a dispatcher cleanup failure without throwing", async () => {
    const dispatcher: Dispatcher = {
      kind: "herdr",
      dispatch: async () => {
        throw new Error("not used");
      },
      status: async () => {
        throw new Error("not used");
      },
      settle: async () => {
        throw new Error("not used");
      },
      available: async () => true,
      cleanup: async () => {
        throw new Error("herdr unreachable");
      },
    };

    const notes = await cleanupMergedWork({ repoPath, worktreePattern, baseBranch: "main", issue, dispatcher });

    expect(notes).toEqual([expect.stringContaining("herdr unreachable")]);
  });
});
