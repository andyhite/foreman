import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../src/git/exec.ts";
import {
  branchNameFor,
  ensureWorktree,
  listWorktrees,
  removeWorktree,
  slugify,
  worktreePathFor,
  worktreeStatus,
} from "../src/git/worktree.ts";

describe("slugify", () => {
  it("lowercases and hyphenates punctuation and spaces", () => {
    expect(slugify("Fix Triage Dedupe!")).toBe("fix-triage-dedupe");
  });

  it("strips unicode diacritics to ASCII", () => {
    expect(slugify("Résumé Parsing Café")).toBe("resume-parsing-cafe");
  });

  it("drops characters with no ASCII fallback rather than exploding", () => {
    expect(slugify("会議 Notes 日本語")).toBe("notes");
  });

  it("collapses runs of separators", () => {
    expect(slugify("a   b---c___d")).toBe("a-b-c-d");
  });

  it("never has leading or trailing hyphens", () => {
    expect(slugify("--- weird title ---")).toBe("weird-title");
  });

  it("truncates long titles to a sane length with no trailing hyphen", () => {
    const long = "this is a very long issue title that goes on and on and on and on and on";
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is stable and collision-free for distinct inputs", () => {
    const a = slugify("Fix bug in parser");
    const b = slugify("Fix bug in parser");
    const c = slugify("Fix bug in lexer");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("falls back to a non-empty slug when nothing survives", () => {
    expect(slugify("!!!")).toBe("issue");
  });
});

describe("branchNameFor", () => {
  it("expands <issue-id>, <ISSUE-ID>, and <slug>", () => {
    const issue = { identifier: "ENG-142", title: "Fix Triage Dedupe" };
    expect(branchNameFor("<issue-id>-<slug>", issue, "/Users/dev/code/plotroom")).toBe(
      "eng-142-fix-triage-dedupe",
    );
    expect(branchNameFor("<ISSUE-ID>/<slug>", issue, "/Users/dev/code/plotroom")).toBe(
      "ENG-142/fix-triage-dedupe",
    );
  });

  it("expands <repo> from the repo basename when repoPath is given", () => {
    const issue = { identifier: "ENG-142", title: "Fix Triage Dedupe" };
    expect(branchNameFor("<repo>/<issue-id>", issue, "/Users/dev/code/plotroom")).toBe(
      "plotroom/eng-142",
    );
  });

  it("rejects an identifier containing \"..\" (path/branch escape)", () => {
    const issue = { identifier: "../../etc-1", title: "Escape" };
    expect(() => branchNameFor("<issue-id>-<slug>", issue, "/repo")).toThrow(/identifier/);
  });

  it("rejects an identifier starting with \"-\" (git option injection)", () => {
    const issue = { identifier: "-force-1", title: "Escape" };
    expect(() => branchNameFor("<issue-id>-<slug>", issue, "/repo")).toThrow(/identifier/);
  });
});

describe("worktreePathFor", () => {
  it("expands <repo> from the repo basename and resolves relative to repoPath", () => {
    const repoPath = "/Users/dev/code/plotroom";
    const issue = { identifier: "ENG-142" };
    const result = worktreePathFor("../<repo>-<ISSUE-ID>", repoPath, issue);
    expect(result).toBe("/Users/dev/code/plotroom-ENG-142");
  });

  it("expands <issue-id> lowercase alongside <ISSUE-ID>", () => {
    const repoPath = "/Users/dev/code/plotroom";
    const issue = { identifier: "ENG-142" };
    const result = worktreePathFor("../<repo>-<issue-id>", repoPath, issue);
    expect(result).toBe("/Users/dev/code/plotroom-eng-142");
  });

  it("expands <slug> when the issue carries a title", () => {
    const repoPath = "/Users/dev/code/plotroom";
    const issue = { identifier: "ENG-142", title: "Fix Triage Dedupe" };
    const result = worktreePathFor("../<repo>-<slug>", repoPath, issue);
    expect(result).toBe("/Users/dev/code/plotroom-fix-triage-dedupe");
  });

  it("rejects an identifier containing \"..\" so a worktree path cannot escape the repo", () => {
    const repoPath = "/Users/dev/code/plotroom";
    const issue = { identifier: "../../etc-1" };
    expect(() => worktreePathFor("../<repo>-<issue-id>", repoPath, issue)).toThrow(/identifier/);
  });
});


function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("worktree lifecycle against a real repo", () => {
  let repoRoot: string;
  let repoPath: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "foreman-worktree-")));
    repoPath = join(repoRoot, "repo");
    execFileSync("git", ["init", "--initial-branch=main", repoPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    git(repoPath, "commit", "--allow-empty", "-m", "initial commit");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("creates a worktree and branch off the local base branch when there is no remote", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    const result = await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    expect(result).toEqual({ created: true, branchExisted: false, worktreePath });

    const entries = await listWorktrees(repoPath);
    const entry = entries.find((e) => e.path === worktreePath);
    expect(entry?.branch).toBe("eng-142-fix");
  });

  it("is idempotent: a second call against the same worktree returns created: false", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    const second = await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    expect(second).toEqual({ created: false, branchExisted: true, worktreePath });
  });

  it("throws when the target path exists as a non-worktree directory", async () => {
    const worktreePath = join(repoRoot, "not-a-worktree");
    mkdirSync(worktreePath);

    await expect(
      ensureWorktree({
        repoPath,
        worktreePath,
        branch: "eng-142-fix",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/not a registered git worktree/);
  });

  it("worktreeStatus reports commits ahead, dirty state, and head sha", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    git(worktreePath, "commit", "--allow-empty", "-m", "second commit");

    const status = await worktreeStatus(worktreePath, "main");
    expect(status.commits.length).toBe(1);
    expect(status.ahead).toBe(1);
    expect(status.dirty).toBe(false);
    expect(status.pushed).toBe(false);
    expect(status.headSha).not.toBeNull();
  });

  it("worktreeStatus reports dirty when there are uncommitted changes", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    writeFileSync(join(worktreePath, "scratch.txt"), "wip");

    const status = await worktreeStatus(worktreePath, "main");
    expect(status.dirty).toBe(true);
  });

  it("resumes onto an existing branch after removeWorktree instead of failing on -b", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    await removeWorktree(repoPath, worktreePath);

    const resumed = await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    expect(resumed).toEqual({ created: true, branchExisted: true, worktreePath });
  });

  it("worktreeStatus degrades gracefully when the base branch has no local ref", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
    });

    const status = await worktreeStatus(worktreePath, "no-such-base-branch");
    expect(status.commits).toEqual([]);
    expect(status.dirty).toBe(false);
    expect(status.headSha).not.toBeNull();
  });

  it("rejects a branch or baseBranch starting with \"-\" (option injection)", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    await expect(
      ensureWorktree({ repoPath, worktreePath, branch: "-force", baseBranch: "main" }),
    ).rejects.toThrow(/branch/);
    await expect(
      ensureWorktree({ repoPath, worktreePath, branch: "eng-142-fix", baseBranch: "-force" }),
    ).rejects.toThrow(/baseBranch/);
  });

  it("matches an already-registered worktree even when the requested path traverses a symlink", async () => {
    const realParent = join(repoRoot, "real-parent");
    mkdirSync(realParent);
    const symlinkedParent = join(repoRoot, "symlinked-parent");
    symlinkSync(realParent, symlinkedParent);
    const worktreePath = join(symlinkedParent, "repo-eng-142");

    const first = await ensureWorktree({ repoPath, worktreePath, branch: "eng-142-fix", baseBranch: "main" });
    expect(first.created).toBe(true);

    // `git worktree list --porcelain` reports the realpath; a second call
    // through the same symlinked path must still recognize it as registered
    // rather than falling through to the "refusing to clobber" guard.
    const second = await ensureWorktree({ repoPath, worktreePath, branch: "eng-142-fix", baseBranch: "main" });
    expect(second).toEqual({ created: false, branchExisted: true, worktreePath });
  });

  it("degrades to the local base ref when fetching the remote fails, rather than rejecting", async () => {
    const worktreePath = join(repoRoot, "repo-eng-142");
    git(repoPath, "remote", "add", "origin", "https://example.invalid/nonexistent.git");

    const warnings: string[] = [];
    const flakyRunner: CommandRunner = {
      async run(argv, options) {
        if (argv[0] === "git" && argv[1] === "fetch") {
          throw new Error("simulated offline: could not resolve host");
        }
        const stdout = execFileSync("git", argv.slice(1), { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { stdout, stderr: "", code: 0 };
      },
    };

    const result = await ensureWorktree({
      repoPath,
      worktreePath,
      branch: "eng-142-fix",
      baseBranch: "main",
      runner: flakyRunner,
      log: (message) => warnings.push(message),
    });

    expect(result.created).toBe(true);
    expect(warnings.some((message) => message.includes("git fetch"))).toBe(true);
  });
});
