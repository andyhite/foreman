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
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { CommandRunner } from "./exec.ts";
import { nodeRunner } from "./exec.ts";

const MAX_SLUG_LENGTH = 48;

/**
 * Lowercase, ASCII, hyphen-separated identifier safe as a git ref component.
 * Only Latin diacritics are folded (NFKD decomposition drops combining
 * marks, e.g. "café" -> "cafe"); other scripts have no ASCII equivalent to
 * fall back to and collapse to the `"issue"` fallback below rather than a
 * collision-prone transliteration guess.
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

/**
 * Linear's issue identifier grammar (`<TEAM>-<number>`, e.g. `ENG-142`). Both
 * `branchNameFor` and `worktreePathFor` interpolate `identifier` unvalidated
 * into a filesystem path / git ref; an identifier containing `..` or a path
 * separator would otherwise escape the repo, and one starting with `-` would
 * be parsed by git as an option rather than a ref.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9]+-\d+$/;

function assertSafeIdentifier(identifier: string): void {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(
      `refusing to build a worktree path/branch name from issue identifier "${identifier}": ` +
        `expected Linear's <TEAM>-<number> grammar`,
    );
  }
}

/** Rejects a ref that git would parse as an option rather than a ref name. */
function assertSafeRef(ref: string, label: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`refusing to pass "${label}" starting with "-" to git: ${ref}`);
  }
}

/** Expand a `branchPattern` (SPEC §3.10) against an issue and its repository. */
export function branchNameFor(
  pattern: string,
  issue: IssueRefLike,
  repoPath: string,
): string {
  assertSafeIdentifier(issue.identifier);
  return pattern
    .replace(/<issue-id>/g, issue.identifier.toLowerCase())
    .replace(/<ISSUE-ID>/g, issue.identifier)
    .replace(/<slug>/g, slugify(issue.title))
    .replace(/<repo>/g, basename(repoPath));
}

/**
 * Expand a `worktreePattern` (SPEC §3.10), resolved relative to `repoPath`.
 * `<slug>` requires the issue's `title`; omitted, it is left unexpanded.
 */
export function worktreePathFor(
  pattern: string,
  repoPath: string,
  issue: Pick<IssueRefLike, "identifier"> & { title?: string },
): string {
  assertSafeIdentifier(issue.identifier);
  const expanded = pattern
    .replace(/<repo>/g, basename(repoPath))
    .replace(/<issue-id>/g, issue.identifier.toLowerCase())
    .replace(/<ISSUE-ID>/g, issue.identifier)
    .replace(/<slug>/g, issue.title !== undefined ? slugify(issue.title) : "<slug>");
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

/** Returns the first configured remote's name, or `null` when there is none. */
async function remoteName(repoPath: string, runner: CommandRunner): Promise<string | null> {
  const { stdout } = await runner.run(["git", "remote"], { cwd: repoPath });
  const name = stdout.split("\n")[0]?.trim();
  return name && name.length > 0 ? name : null;
}

/** True when `ref` resolves in `repoPath` (a local branch or a fetched remote-tracking ref). */
async function refExists(repoPath: string, ref: string, runner: CommandRunner): Promise<boolean> {
  try {
    await runner.run(["git", "rev-parse", "--verify", ref], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export interface EnsureWorktreeInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  runner?: CommandRunner;
  /** Warnings only — e.g. degrading past an unreachable remote (SPEC §3.10's offline tolerance). Defaults to a no-op. */
  log?: (message: string) => void;
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
  const log = input.log ?? (() => {});

  assertSafeRef(branch, "branch");
  assertSafeRef(baseBranch, "baseBranch");

  const existing = await listWorktrees(repoPath, runner);
  // `git worktree list --porcelain` always reports realpaths, so a
  // symlinked path component (a symlinked `/tmp` on macOS, a symlinked
  // checkout root) makes a raw-equality match against `worktreePath` never
  // hit even though the worktree is in fact already registered.
  const target = existsSync(worktreePath) ? realpathSync(worktreePath) : worktreePath;
  const registered = existing.find((entry) => entry.path === target || entry.path === worktreePath);
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

  const remote = await remoteName(repoPath, runner);
  let baseRef = baseBranch;
  if (remote !== null) {
    try {
      await runner.run(["git", "fetch", remote, baseBranch], { cwd: repoPath });
      baseRef = `${remote}/${baseBranch}`;
    } catch (error) {
      // Offline, or the remote is briefly unreachable: degrade to the local
      // base ref rather than fail every implement dispatch and burn the
      // retry cap (SPEC §17.8), mirroring how `worktreeStatus` degrades
      // rather than rejects when a git call fails.
      if (!(await refExists(repoPath, `refs/heads/${baseBranch}`, runner))) throw error;
      log(
        `git fetch ${remote} ${baseBranch} failed (${String(error)}); using the local ` +
          `${baseBranch} ref instead`,
      );
    }
  }

  // Derived from refs, not from the worktree list: a branch left behind by
  // `removeWorktree` (worktree gone, ref still present) must re-attach via
  // `worktree add <path> <branch>`, not retry `-b` and fail on "already exists".
  const branchExisted = await refExists(repoPath, `refs/heads/${branch}`, runner);
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
  const remote = await remoteName(worktreePath, runner);
  const remoteBase = remote !== null ? `${remote}/${baseBranch}` : null;
  const base =
    remoteBase !== null && (await refExists(worktreePath, remoteBase, runner))
      ? remoteBase
      : baseBranch;

  // A worktree whose base branch has no local ref yet (the usual state right
  // after `ensureWorktree` created it from a remote base) must degrade, not
  // reject — this is exactly the data a blocked run's `stateLeftBehind` needs.
  const [logResult, statusResult, headResult] = await Promise.all([
    runner
      .run(["git", "log", `${base}..HEAD`, "--format=%H %s"], { cwd: worktreePath })
      .catch(() => null),
    runner.run(["git", "status", "--porcelain"], { cwd: worktreePath }).catch(() => null),
    runner.run(["git", "rev-parse", "HEAD"], { cwd: worktreePath }).catch(() => null),
  ]);

  const commits = logResult
    ? logResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
  const dirty = statusResult !== null && statusResult.stdout.trim().length > 0;
  const headSha = headResult ? headResult.stdout.trim() : null;

  let pushed = false;
  if (remote !== null) {
    try {
      const branchName = (
        await runner.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
      ).stdout.trim();
      const upstream = await runner.run(
        ["git", "rev-parse", `${remote}/${branchName}`],
        { cwd: worktreePath },
      );
      pushed = headSha !== null && upstream.stdout.trim() === headSha;
    } catch {
      pushed = false;
    }
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
