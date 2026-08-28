/**
 * Foreman-owned worktree lifecycle (SPEC §12, §3.7).
 *
 * omp's isolation layer tears the workspace down at session end, which is
 * incompatible with the block protocol: a blocked implement run must leave
 * its worktree standing so the operator can inspect it and a resume can pick
 * it back up (§7.3). So the extension creates worktrees itself, before the
 * implement agent spawns, and this module is the only place that shells out
 * to `git worktree`.
 */
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { CommandRunner } from "./exec.ts";
import { nodeRunner } from "./exec.ts";

const MAX_SLUG_LENGTH = 48;

/**
 * Lowercase, ASCII, hyphen-separated identifier safe as a git ref component.
 * Collision-free stability matters more than prettiness: two titles that
 * differ only in punctuation must not collapse to the same slug if that
 * punctuation carried meaning, so we transliterate rather than discard
 * unknown characters outright where a reasonable ASCII fallback exists.
 */
export function slugify(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, ""); // strip combining diacritics after NFKD split
  const ascii = normalized.replace(/[^\x00-\x7F]/g, "");
  const hyphenated = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = hyphenated.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated.length > 0 ? truncated : "issue";
}

interface IssueRefLike {
  identifier: string;
  title: string;
}

/** Expand a `branchPattern` (SPEC §3.10) against an issue. */
export function branchNameFor(pattern: string, issue: IssueRefLike): string {
  return pattern
    .replace(/<issue-id>/g, issue.identifier.toLowerCase())
    .replace(/<ISSUE-ID>/g, issue.identifier)
    .replace(/<slug>/g, slugify(issue.title));
}

/** Expand a `worktreePattern` (SPEC §3.10), resolved relative to `repoPath`. */
export function worktreePathFor(
  pattern: string,
  repoPath: string,
  issue: Pick<IssueRefLike, "identifier">,
): string {
  const expanded = pattern
    .replace(/<repo>/g, basename(repoPath))
    .replace(/<issue-id>/g, issue.identifier.toLowerCase())
    .replace(/<ISSUE-ID>/g, issue.identifier);
  return resolvePath(repoPath, expanded);
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` output into structured entries. */
function parsePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        prunable: current.prunable ?? false,
      });
    }
    current = null;
  };

  for (const line of output.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    // Every other porcelain key belongs to the `worktree` header above it, so a
    // key before the first header is malformed output rather than a new entry.
    if (current === null) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

export async function listWorktrees(
  repoPath: string,
  runner: CommandRunner = nodeRunner,
): Promise<WorktreeEntry[]> {
  const { stdout } = await runner.run(["git", "worktree", "list", "--porcelain"], {
    cwd: repoPath,
  });
  return parsePorcelain(stdout);
}

async function remoteExists(repoPath: string, runner: CommandRunner): Promise<boolean> {
  const { stdout } = await runner.run(["git", "remote"], { cwd: repoPath });
  return stdout.trim().length > 0;
}

export interface EnsureWorktreeInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  runner?: CommandRunner;
}

export interface EnsureWorktreeResult {
  created: boolean;
  branchExisted: boolean;
  worktreePath: string;
}

/**
 * Idempotent worktree creation. A second call against an already-registered
 * worktree for `branch` is the resume path (SPEC §7.3 step 2) — it must
 * return `created: false` rather than fail, since a resumed implement run
 * calls this on every attempt.
 */
export async function ensureWorktree(
  input: EnsureWorktreeInput,
): Promise<EnsureWorktreeResult> {
  const { repoPath, worktreePath, branch, baseBranch } = input;
  const runner = input.runner ?? nodeRunner;

  const existing = await listWorktrees(repoPath, runner);
  const registered = existing.find((entry) => entry.path === worktreePath);
  if (registered) {
    if (registered.branch !== branch) {
      throw new Error(
        `worktree at ${worktreePath} is registered for branch ` +
          `${registered.branch ?? "(detached)"}, not ${branch}`,
      );
    }
    return { created: false, branchExisted: true, worktreePath };
  }

  if (existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} exists but is not a registered git worktree; refusing to clobber it`,
    );
  }

  const hasRemote = await remoteExists(repoPath, runner);
  let baseRef = baseBranch;
  if (hasRemote) {
    await runner.run(["git", "fetch", "origin", baseBranch], { cwd: repoPath });
    baseRef = `origin/${baseBranch}`;
  }

  const branchExisted = existing.some((entry) => entry.branch === branch);
  if (branchExisted) {
    await runner.run(["git", "worktree", "add", worktreePath, branch], { cwd: repoPath });
  } else {
    await runner.run(
      ["git", "worktree", "add", "-b", branch, worktreePath, baseRef],
      { cwd: repoPath },
    );
  }

  return { created: true, branchExisted, worktreePath };
}

/**
 * Merged-worktree cleanup only (SPEC §12: "Cleanup of merged worktrees is a
 * scheduled chore, not an agent responsibility"). Never called by an agent,
 * and never by the reaper — the reaper reports, the operator decides (§11).
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  runner: CommandRunner = nodeRunner,
): Promise<void> {
  await runner.run(["git", "worktree", "remove", worktreePath], { cwd: repoPath });
}

export interface WorktreeStatus {
  commits: string[];
  dirty: boolean;
  ahead: number;
  pushed: boolean;
  headSha: string | null;
}

/**
 * Everything the implement skill needs to tell a fresh start from a resume,
 * and everything a `BlockRecord.stateLeftBehind` needs to describe.
 */
export async function worktreeStatus(
  worktreePath: string,
  baseBranch: string,
  runner: CommandRunner = nodeRunner,
): Promise<WorktreeStatus> {
  const [logResult, statusResult, headResult] = await Promise.all([
    runner.run(["git", "log", `${baseBranch}..HEAD`, "--format=%H %s"], {
      cwd: worktreePath,
    }),
    runner.run(["git", "status", "--porcelain"], { cwd: worktreePath }),
    runner.run(["git", "rev-parse", "HEAD"], { cwd: worktreePath }).catch(() => null),
  ]);

  const commits = logResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const dirty = statusResult.stdout.trim().length > 0;
  const headSha = headResult ? headResult.stdout.trim() : null;

  let pushed = false;
  try {
    const branchName = (
      await runner.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
    ).stdout.trim();
    const upstream = await runner.run(
      ["git", "rev-parse", `origin/${branchName}`],
      { cwd: worktreePath },
    );
    pushed = headSha !== null && upstream.stdout.trim() === headSha;
  } catch {
    pushed = false;
  }

  return { commits, dirty, ahead: commits.length, pushed, headSha };
}

/** Unified diff of `base..head`, for review dispatch when `pr.required: false`. */
export async function diffRange(
  repoPath: string,
  base: string,
  head: string,
  runner: CommandRunner = nodeRunner,
): Promise<string> {
  const { stdout } = await runner.run(["git", "diff", `${base}..${head}`], {
    cwd: repoPath,
  });
  return stdout;
}
