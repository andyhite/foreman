import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "../src/git/exec.ts";
import { DirtyWorkingTreeError, GitHubClient } from "../src/github/client.ts";

interface RecordedCall {
  argv: string[];
  cwd: string;
}

function stubRunner(
  respond: (argv: string[]) => { stdout: string; stderr?: string; code?: number },
): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    run(argv, options) {
      calls.push({ argv, cwd: options.cwd });
      const result = respond(argv);
      return Promise.resolve({
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
      });
    },
  };
  return { runner, calls };
}

describe("GitHubClient.prForBranch", () => {
  it("returns null on empty JSON output", async () => {
    const { runner } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    const result = await client.prForBranch("/repo", "eng-142-fix");
    expect(result).toBeNull();
  });

  it("returns null when the list is an empty array", async () => {
    const { runner } = stubRunner(() => ({ stdout: "[]" }));
    const client = new GitHubClient({ runner });
    const result = await client.prForBranch("/repo", "eng-142-fix");
    expect(result).toBeNull();
  });

  it("parses a found PR, defaulting to open PRs only", async () => {
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          headRefOid: "abc123",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          baseRefName: "main",
        },
      ]),
    }));
    const client = new GitHubClient({ runner });
    const result = await client.prForBranch("/repo", "eng-142-fix");
    expect(result).toEqual({
      number: 7,
      url: "https://github.com/org/repo/pull/7",
      headSha: "abc123",
      state: "OPEN",
      isDraft: false,
      mergeable: true,
      baseBranch: "main",
    });
    expect(calls[0]?.argv).toContain("--head");
    expect(calls[0]?.argv).toContain("eng-142-fix");
    expect(calls[0]?.argv).toContain("--state");
    expect(calls[0]?.argv[calls[0]!.argv.indexOf("--state") + 1]).toBe("open");
  });

  it("passes --state all when asked to find merged PRs", async () => {
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          headRefOid: "abc123",
          state: "MERGED",
          isDraft: false,
          mergeable: "UNKNOWN",
          baseRefName: "main",
        },
      ]),
    }));
    const client = new GitHubClient({ runner });
    const result = await client.prForBranch("/repo", "eng-142-fix", { state: "all" });
    expect(result?.state).toBe("MERGED");
    expect(calls[0]?.argv[calls[0]!.argv.indexOf("--state") + 1]).toBe("all");
  });
});


describe("GitHubClient.ciStatus", () => {
  it("reads the `status` field, not `state`, from check runs", async () => {
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "neutral" },
          ],
        },
      ]),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("success");
    expect(calls[0]?.argv).toContain("--paginate");
  });

  it("maps any failing conclusion to failure", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
          ],
        },
      ]),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("failure");
  });

  it("maps any incomplete run to pending", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "in_progress", conclusion: null },
          ],
        },
      ]),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("pending");
  });

  it("distinguishes 'none' (no checks configured) from pending", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify([{ check_runs: [] }]),
    }));
    const client = new GitHubClient({ runner });
    const status = await client.ciStatus("/repo", "abc123");
    expect(status).toBe("none");
    expect(status).not.toBe("pending");
  });

  it("merges check runs across paginated pages", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify([
        { check_runs: [{ status: "completed", conclusion: "success" }] },
        { check_runs: [{ status: "completed", conclusion: "failure" }] },
      ]),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("failure");
  });
});


describe("GitHubClient.mergePr", () => {
  it("builds --squash argv for squash strategy", async () => {
    const { runner, calls } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    await client.mergePr("/repo", 7, "squash", true);
    expect(calls[0]?.argv).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--squash",
      "--delete-branch",
    ]);
  });

  it("builds --rebase argv without delete-branch when not requested", async () => {
    const { runner, calls } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    await client.mergePr("/repo", 7, "rebase", false);
    expect(calls[0]?.argv).toEqual(["gh", "pr", "merge", "7", "--rebase"]);
  });

  it("builds --merge argv for merge strategy", async () => {
    const { runner, calls } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    await client.mergePr("/repo", 7, "merge", true);
    expect(calls[0]?.argv).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--merge",
      "--delete-branch",
    ]);
  });

  it("every call passes argv as an array, never a shell string", async () => {
    const { runner, calls } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    await client.mergePr("/repo; rm -rf /", 7, "squash", true);
    for (const call of calls) {
      expect(Array.isArray(call.argv)).toBe(true);
      for (const arg of call.argv) {
        expect(typeof arg).toBe("string");
      }
    }
  });
});

describe("GitHubClient.isMerged", () => {
  it("reads MERGED state as true", async () => {
    const { runner } = stubRunner(() => ({ stdout: JSON.stringify({ state: "MERGED" }) }));
    const client = new GitHubClient({ runner });
    expect(await client.isMerged("/repo", 7)).toBe(true);
  });

  it("reads OPEN state as false", async () => {
    const { runner } = stubRunner(() => ({ stdout: JSON.stringify({ state: "OPEN" }) }));
    const client = new GitHubClient({ runner });
    expect(await client.isMerged("/repo", 7)).toBe(false);
  });
});

describe("GitHubClient.mergeBranchLocally", () => {
  it("refuses to merge when the repo has uncommitted changes", async () => {
    const { runner } = stubRunner((argv) => {
      if (argv.includes("status")) {
        return { stdout: " M dirty-file.txt\n" };
      }
      return { stdout: "" };
    });
    const client = new GitHubClient({ runner });
    await expect(
      client.mergeBranchLocally("/repo", "eng-142-fix", "main", "merge", false),
    ).rejects.toThrow(DirtyWorkingTreeError);
  });

  it("restores the starting ref after merging, even on failure", async () => {
    const { runner, calls } = stubRunner((argv) => {
      if (argv.includes("status")) return { stdout: "" };
      if (argv.includes("symbolic-ref")) return { stdout: "feature-branch\n" };
      if (argv.includes("rebase")) throw new Error("rebase conflict");
      return { stdout: "" };
    });
    const client = new GitHubClient({ runner });
    await expect(
      client.mergeBranchLocally("/repo", "eng-142-fix", "main", "rebase", false),
    ).rejects.toThrow();
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.argv).toEqual(["git", "checkout", "feature-branch"]);
  });
});

describe("GitHubClient.repoSlug", () => {
  it("parses owner/name from gh repo view --json output", async () => {
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.repoSlug("/repo")).toEqual({ owner: "acme", repo: "plotroom" });
    expect(calls[0]?.argv).toEqual(["gh", "repo", "view", "--json", "owner,name"]);
  });
});

describe("GitHubClient.createReview", () => {
  it("without an appAuth, posts through gh api using whatever gh is authenticated as", async () => {
    const { runner, calls } = stubRunner(() => ({ stdout: "" }));
    const client = new GitHubClient({ runner });
    await client.createReview("/repo", 7, { event: "COMMENT", body: "Looks fine." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      "gh",
      "api",
      "repos/{owner}/{repo}/pulls/7/reviews",
      "-X",
      "POST",
      "-f",
      "event=COMMENT",
      "-f",
      "body=Looks fine.",
    ]);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  it("with an appAuth configured, resolves repoSlug and overrides GH_TOKEN with the installation token", async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const runner: CommandRunner = {
      run(argv, options) {
        calls.push({ argv, env: options.env });
        if (argv[0] === "gh" && argv[1] === "repo" && argv[2] === "view") {
          return Promise.resolve({ stdout: JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }), stderr: "", code: 0 });
        }
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };
    const appAuth = { installationToken: async (owner: string, repo: string) => `token-for-${owner}-${repo}` };
    const client = new GitHubClient({ runner, appAuth: appAuth as never });
    await client.createReview("/repo", 7, { event: "APPROVE", body: "Ship it." });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.argv).toEqual(["gh", "repo", "view", "--json", "owner,name"]);
    const reviewCall = calls[1];
    expect(reviewCall?.argv).toEqual([
      "gh",
      "api",
      "repos/{owner}/{repo}/pulls/7/reviews",
      "-X",
      "POST",
      "-f",
      "event=APPROVE",
      "-f",
      "body=Ship it.",
    ]);
    expect(reviewCall?.env?.GH_TOKEN).toBe("token-for-acme-plotroom");
  });
});
