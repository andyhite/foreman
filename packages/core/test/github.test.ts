import { describe, expect, it } from "bun:test";
import type { CommandRunner } from "../src/git/exec.ts";
import { GitHubClient } from "../src/github/client.ts";

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

  it("parses a found PR", async () => {
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          url: "https://github.com/org/repo/pull/7",
          headRefOid: "abc123",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
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
    });
    expect(calls[0]?.argv).toContain("--head");
    expect(calls[0]?.argv).toContain("eng-142-fix");
  });
});

describe("GitHubClient.ciStatus", () => {
  it("maps a fully successful check-run set to success", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify({
        check_runs: [
          { state: "completed", conclusion: "success" },
          { state: "completed", conclusion: "neutral" },
        ],
      }),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("success");
  });

  it("maps any failing conclusion to failure", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify({
        check_runs: [
          { state: "completed", conclusion: "success" },
          { state: "completed", conclusion: "failure" },
        ],
      }),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("failure");
  });

  it("maps any incomplete run to pending", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify({
        check_runs: [
          { state: "completed", conclusion: "success" },
          { state: "in_progress", conclusion: null },
        ],
      }),
    }));
    const client = new GitHubClient({ runner });
    expect(await client.ciStatus("/repo", "abc123")).toBe("pending");
  });

  it("distinguishes 'none' (no checks configured) from pending", async () => {
    const { runner } = stubRunner(() => ({
      stdout: JSON.stringify({ check_runs: [] }),
    }));
    const client = new GitHubClient({ runner });
    const status = await client.ciStatus("/repo", "abc123");
    expect(status).toBe("none");
    expect(status).not.toBe("pending");
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
