/**
 * Extension-internal GitHub reads plus the operator-invoked merge (SPEC
 * §3.10, `/foreman-merge`). Shells out to the already-authenticated `gh`
 * CLI through the same `CommandRunner` seam as `git/` — never `curl`, never
 * a raw token, so Foreman never handles GitHub credentials directly.
 */

import type { CommandRunner } from "../git/exec.ts";
import { nodeRunner } from "../git/exec.ts";

export type MergeStrategy = "merge" | "squash" | "rebase";
export type CiState = "success" | "failure" | "pending" | "none";

export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  state: string;
  isDraft: boolean;
  mergeable: boolean | null;
}

interface GhPrListEntry {
  number: number;
  url: string;
  headRefOid: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
}

interface GhCheckRun {
  status: string;
  conclusion: string | null;
}

/**
 * Thrown by `mergeBranchLocally` when `repoPath` — the operator's own
 * checkout, not a worktree — has uncommitted changes. Merging into a dirty
 * tree would either fail mid-sequence after `baseBranch` is already pulled,
 * or silently carry the operator's changes onto `baseBranch` and push them.
 */
export class DirtyWorkingTreeError extends Error {
  constructor(repoPath: string) {
    super(
      `${repoPath} has uncommitted changes; commit or stash them before merging locally`,
    );
    this.name = "DirtyWorkingTreeError";
  }
}

export class GitHubClient {
  readonly #runner: CommandRunner;

  constructor(options?: { runner?: CommandRunner }) {
    this.#runner = options?.runner ?? nodeRunner;
  }

  /** `gh pr list --head <branch>`; `options.state` defaults to `"open"` (Contract 2). */
  async prForBranch(
    repoPath: string,
    branch: string,
    options?: { state?: "open" | "all" },
  ): Promise<PullRequestInfo | null> {
    const { stdout } = await this.#runner.run(
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        options?.state ?? "open",
        "--json",
        "number,url,headRefOid,state,isDraft,mergeable",
        "--limit",
        "1",
      ],
      { cwd: repoPath },
    );

    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const entries = JSON.parse(trimmed) as GhPrListEntry[];
    const entry = entries[0];
    if (!entry) {
      return null;
    }
    return {
      number: entry.number,
      url: entry.url,
      headSha: entry.headRefOid,
      state: entry.state,
      isDraft: entry.isDraft,
      mergeable: entry.mergeable === "UNKNOWN" ? null : entry.mergeable === "MERGEABLE",
    };
  }

  /**
   * `gh pr create` for `foreman_github_pr`'s `create` op (SPEC §7.3, §13.2):
   * the PR must exist before an implement agent yields, since the extension
   * never rewrites the PR body from the `ImplementResult` after the fact.
   */
  async createPr(
    repoPath: string,
    options: { title: string; body: string; head: string; base: string; draft: boolean },
  ): Promise<{ number: number; url: string; headSha: string }> {
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      options.title,
      "--body",
      options.body,
      "--head",
      options.head,
      "--base",
      options.base,
    ];
    if (options.draft) args.push("--draft");
    await this.#runner.run(args, { cwd: repoPath });

    const info = await this.prForBranch(repoPath, options.head);
    if (!info) {
      throw new Error(`gh pr create reported success but no PR was found for ${options.head}`);
    }
    return { number: info.number, url: info.url, headSha: info.headSha };
  }

  /** Unified diff for review dispatch when `pr.required: true`. */
  async prDiff(repoPath: string, number: number): Promise<string> {
    const { stdout } = await this.#runner.run(
      ["gh", "pr", "diff", String(number)],
      { cwd: repoPath },
    );
    return stdout;
  }

  /**
   * `"none"` means no checks are configured for `ref` — distinct from
   * `"pending"`, which means checks exist but have not finished. Collapsing
   * the two would let an unconfigured CI setup read as green.
   */
  async ciStatus(repoPath: string, ref: string): Promise<CiState> {
    const { stdout } = await this.#runner.run(
      [
        "gh",
        "api",
        "--paginate",
        "--slurp",
        `repos/{owner}/{repo}/commits/${ref}/check-runs`,
      ],
      { cwd: repoPath },
    );
    const pages = JSON.parse(stdout) as { check_runs: GhCheckRun[] }[];
    const runs = pages.flatMap((page) => page.check_runs);
    if (runs.length === 0) {
      return "none";
    }
    if (runs.some((run) => run.status !== "completed")) {
      return "pending";
    }
    if (runs.some((run) => run.conclusion !== "success" && run.conclusion !== "neutral")) {
      return "failure";
    }
    return "success";
  }

  /**
   * Merges the PR with the configured strategy. Gate-checking (SPEC §10) is
   * the caller's job — this method performs the merge unconditionally once
   * called, it does not itself verify review/CI state.
   */
  async mergePr(
    repoPath: string,
    number: number,
    strategy: MergeStrategy,
    deleteBranch: boolean,
  ): Promise<void> {
    const strategyFlag =
      strategy === "squash" ? "--squash" : strategy === "rebase" ? "--rebase" : "--merge";
    const argv = ["gh", "pr", "merge", String(number), strategyFlag];
    if (deleteBranch) {
      argv.push("--delete-branch");
    }
    await this.#runner.run(argv, { cwd: repoPath });
  }

  async isMerged(repoPath: string, number: number): Promise<boolean> {
    const { stdout } = await this.#runner.run(
      ["gh", "pr", "view", String(number), "--json", "state"],
      { cwd: repoPath },
    );
    const parsed = JSON.parse(stdout) as { state: string };
    return parsed.state === "MERGED";
  }

  /**
   * The merge-detection worker's read (SPEC §16 item 7): Linear's GitHub
   * integration only auto-transitions when a team workflow automation has
   * been configured, so Foreman polls merge state itself rather than
   * trusting Linear to notice.
   */
  async mergedBranches(
    repoPath: string,
    base: string,
    branches: readonly string[],
  ): Promise<string[]> {
    const merged: string[] = [];
    for (const branch of branches) {
      const { stdout } = await this.#runner.run(
        ["git", "branch", "--merged", base, "--list", branch],
        { cwd: repoPath },
      );
      if (stdout.trim().length > 0) {
        merged.push(branch);
      }
    }
    return merged;
  }

  /**
   * The direct-branch-mode half of `/foreman-merge` (`pr.required: false`,
   * SPEC §3.10). Operates directly in `repoPath` — the operator's own
   * checkout, not a worktree — so it refuses a dirty tree up front and
   * restores whatever ref was checked out before it started, in a `finally`,
   * rather than leaving the operator stranded on `baseBranch`.
   */
  async mergeBranchLocally(
    repoPath: string,
    branch: string,
    baseBranch: string,
    strategy: MergeStrategy,
    deleteBranch: boolean,
  ): Promise<void> {
    const status = await this.#runner.run(["git", "status", "--porcelain"], { cwd: repoPath });
    if (status.stdout.trim().length > 0) {
      throw new DirtyWorkingTreeError(repoPath);
    }

    const startingRef = (
      await this.#runner.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], {
        cwd: repoPath,
      }).catch(() =>
        this.#runner.run(["git", "rev-parse", "HEAD"], { cwd: repoPath }),
      )
    ).stdout.trim();

    try {
      await this.#runner.run(["git", "checkout", baseBranch], { cwd: repoPath });
      await this.#runner.run(["git", "pull", "origin", baseBranch], { cwd: repoPath });

      if (strategy === "squash") {
        await this.#runner.run(["git", "merge", "--squash", branch], { cwd: repoPath });
        await this.#runner.run(
          ["git", "commit", "-m", `Merge branch '${branch}' (squash)`],
          { cwd: repoPath },
        );
      } else if (strategy === "rebase") {
        await this.#runner.run(["git", "rebase", branch], { cwd: repoPath });
      } else {
        await this.#runner.run(["git", "merge", "--no-ff", branch], { cwd: repoPath });
      }

      await this.#runner.run(["git", "push", "origin", baseBranch], { cwd: repoPath });

      if (deleteBranch) {
        await this.#runner.run(["git", "branch", "-D", branch], { cwd: repoPath });
        await this.#runner.run(["git", "push", "origin", "--delete", branch], {
          cwd: repoPath,
        });
      }
    } finally {
      await this.#runner.run(["git", "checkout", startingRef], { cwd: repoPath });
    }
  }
}
