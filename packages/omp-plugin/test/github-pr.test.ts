import { afterEach, describe, expect, it, mock } from "bun:test";
import { realpathSync } from "node:fs";
import type { GitHubClient, PullRequestInfo, ResolvedRepoEntry } from "@foreman/core";
import { registerGitHubPrTool } from "../src/tools/github-pr.ts";

const entry: ResolvedRepoEntry = {
  alias: "test",
  repoPath: realpathSync("."),
  team: "ENG",
  apps: [],
  appNames: [],
  baseBranch: "main",
  pr: { required: true, draft: false, ciRequired: false },
  merge: { strategy: "squash", deleteBranch: true },
  branchPattern: "<issue-id>-<slug>",
  worktreePattern: "../<repo>-<ISSUE-ID>",
};

const fakePr = { number: 1, url: "https://github.com/o/r/pull/1" } as unknown as PullRequestInfo;

function makeGithub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    createPr: async () => fakePr,
    prForBranch: async () => null,
    ...overrides,
  } as unknown as GitHubClient;
}

interface CapturedTool {
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

async function registerAndGetTool(): Promise<CapturedTool> {
  let captured: CapturedTool | undefined;
  const zodStub: unknown = new Proxy(() => zodStub, {
    get: (_target, prop) => (prop === "then" ? undefined : (..._args: unknown[]) => zodStub),
  });
  const fakePi = {
    zod: zodStub,
    registerTool: (config: CapturedTool) => {
      captured = config;
    },
  };
  registerGitHubPrTool(fakePi as never);
  if (!captured) throw new Error("tool was not registered");
  return captured;
}

describe("foreman_github_pr — base branch pinning (step 3.6)", () => {
  // Dynamic import: exercises bun's module-mocking boundary — the tool's
  // `getEntry`/`getGitHub` calls must be re-imported after `mock.module`
  // swaps the module registry entry, which only takes effect for imports
  // evaluated after this call (mirrors extension.test.ts's session_start
  // mocking of the same module).
  let actualRuntime: typeof import("../src/runtime.ts") | undefined;

  afterEach(() => {
    if (actualRuntime) mock.module("../src/runtime.ts", () => actualRuntime);
  });

  async function withRuntime(github: GitHubClient): Promise<CapturedTool> {
    actualRuntime = await import("../src/runtime.ts");
    mock.module("../src/runtime.ts", () => ({
      ...actualRuntime,
      getEntry: () => entry,
      getGitHub: () => github,
    }));
    return registerAndGetTool();
  }

  it("rejects a base branch other than the repo's configured baseBranch", async () => {
    const createPr = mock(async () => fakePr);
    const tool = await withRuntime(makeGithub({ createPr }));
    const result = await tool.execute("call-1", {
      op: "create",
      repoPath: entry.repoPath,
      title: "t",
      body: "b",
      head: "feature-branch",
      base: "release",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("base must be main");
    expect(createPr).not.toHaveBeenCalled();
  });

  it("succeeds when base matches the repo's configured baseBranch", async () => {
    const createPr = mock(async () => fakePr);
    const tool = await withRuntime(makeGithub({ createPr }));
    const result = await tool.execute("call-2", {
      op: "create",
      repoPath: entry.repoPath,
      title: "t",
      body: "b",
      head: "feature-branch",
      base: "main",
    });
    expect(result.isError).toBeUndefined();
    expect(createPr).toHaveBeenCalledTimes(1);
  });
});
