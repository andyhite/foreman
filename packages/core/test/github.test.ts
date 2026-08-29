import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "../src/config/schema.ts";
import { HerdrDispatcher, herdrAgentName } from "../src/dispatch/herdr.ts";
import { PrintDispatcher } from "../src/dispatch/print.ts";
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

describe("PrintDispatcher", () => {
  it("scrubs configured credentials and returns the actual settled outcome", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "foreman-print-"));
    const scriptPath = join(scriptDir, "print-env");
    writeFileSync(scriptPath, "#!/bin/sh\nprintf '%s' \"${FOREMAN_TEST_SCRUB-unset}\"\n");
    chmodSync(scriptPath, 0o755);
    const prior = process.env.FOREMAN_TEST_SCRUB;
    process.env.FOREMAN_TEST_SCRUB = "secret";
    try {
      const config = {
        agent: { ompBin: scriptPath, approvalMode: "full-auto", maxRuntimeMs: 0 },
      } as GlobalConfig;
      const dispatcher = new PrintDispatcher(config, { scrubEnv: ["FOREMAN_TEST_SCRUB"] });
      const handle = await dispatcher.dispatch({
        agent: "foreman-implement",
        issueId: "ENG-142",
        command: "/foreman-implement",
        dispatchId: "dispatch-1",
        cwd: scriptDir,
      });

      const outcome = await dispatcher.settle(handle);
      expect(outcome).toMatchObject({ status: "settled", exitCode: 0, log: "unset" });
    } finally {
      if (prior === undefined) delete process.env.FOREMAN_TEST_SCRUB;
      else process.env.FOREMAN_TEST_SCRUB = prior;
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });
});

describe("HerdrDispatcher", () => {
  it("rediscovers existing workspaces and issue tabs after a dispatcher restart", async () => {
    const calls: string[][] = [];
    const runner = {
      async run(argv: string[]) {
        calls.push(argv);
        if (argv[1] === "workspace" && argv[2] === "list") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: { workspaces: [{ label: "/repo", workspace_id: "w1" }] },
            }),
          };
        }
        if (argv[1] === "tab" && argv[2] === "list") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: { tabs: [{ label: "ENG-142", tab_id: "w1:t2" }] },
            }),
          };
        }
        if (argv[1] === "pane" && argv[2] === "split") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ result: { pane: { pane_id: "w1:t2:p2" } } }),
          };
        }
        return { code: 0, stderr: "", stdout: "{}" };
      },
    };
    const config = {
      agent: {
        herdrBin: "herdr",
        approvalMode: "full-auto",
        maxRuntimeMs: 0,
        lockTtlMarginMs: 0,
      },
    } as GlobalConfig;
    const dispatcher = new HerdrDispatcher(config, { runner });
    await dispatcher.dispatch({
      agent: "foreman-implement",
      issueId: "ENG-142",
      command: "/foreman-implement",
      dispatchId: "dispatch-1",
      cwd: "/repo",
    });
    expect(calls.some((argv) => argv[1] === "workspace" && argv[2] === "create")).toBe(false);
    expect(calls.some((argv) => argv[1] === "tab" && argv[2] === "create")).toBe(false);
  });
});

describe("herdrAgentName", () => {
  it("retains the random dispatch-id suffix when truncating batch agent names", () => {
    const first = herdrAgentName("triage-batch-20260829T120000-aaaa1111");
    const second = herdrAgentName("triage-batch-20260829T120000-bbbb2222");
    expect(first).not.toBe(second);
    expect(first).toEndWith("aaaa1111");
    expect(second).toEndWith("bbbb2222");
    expect(first.length).toBeLessThanOrEqual(32);
  });
});
