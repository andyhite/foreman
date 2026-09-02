import { describe, expect, it } from "bun:test";
import type { GlobalConfig } from "../src/config/schema.ts";
import {
  HerdrDispatcher,
  HerdrUnavailableError,
  isHerdrUnavailable,
} from "../src/dispatch/herdr.ts";

function makeConfig(): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      mode: "confirm",
      workerModes: {},
      mergeDetection: true,
      cleanupMergedWorktrees: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql" },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr" },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

const unavailableRunner = {
  run() {
    return Promise.reject(new HerdrUnavailableError("herdr workspace list timed out after 30000ms"));
  },
};

describe("HerdrDispatcher timeouts", () => {
  it("propagates HerdrUnavailableError from hung subprocess calls", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    await expect(
      dispatcher.dispatch({
        agent: "foreman-refine",
        issueId: "ENG-1",
        command: "/foreman:refine ENG-1",
        dispatchId: "dispatch-1",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(HerdrUnavailableError);
  });

  it("treats HerdrUnavailableError as unavailable in available()", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    await expect(dispatcher.available()).resolves.toBe(false);
  });

  it("classifies HerdrUnavailableError with isHerdrUnavailable", () => {
    expect(isHerdrUnavailable(new HerdrUnavailableError("timed out"))).toBe(true);
    expect(isHerdrUnavailable(new Error("other"))).toBe(false);
  });
});

describe("HerdrDispatcher.cleanup", () => {
  it("closes the issue's tab when both the workspace and tab exist", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ label: "/repos/product", workspace_id: "w1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("tab") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { tabs: [{ label: "ENG-142", tab_id: "w1:t1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("tab") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product");

    expect(calls).toEqual([
      ["herdr", "workspace", "list"],
      ["herdr", "tab", "list", "--workspace", "w1"],
      ["herdr", "tab", "close", "w1:t1"],
    ]);
  });

  it("is a no-op when the repo has no workspace yet", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", code: 0 });
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product");

    expect(calls).toEqual([["herdr", "workspace", "list"]]);
  });

  it("is a no-op when the workspace exists but the issue never got a tab", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ label: "/repos/product", workspace_id: "w1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "", code: 0 });
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product");

    expect(calls).toEqual([
      ["herdr", "workspace", "list"],
      ["herdr", "tab", "list", "--workspace", "w1"],
    ]);
  });
});
