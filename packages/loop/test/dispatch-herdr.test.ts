import { describe, expect, it } from "bun:test";
import type { GlobalConfig } from "@foreman/core";
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
        worktree: null,
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
  it("closes the issue's worktree workspace when it has one", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: {
                workspaces: [
                  { workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product-ENG-142" } },
                ],
              },
            }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("workspace") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product", "/repos/product-ENG-142");

    expect(calls).toEqual([
      ["herdr", "workspace", "list"],
      ["herdr", "workspace", "close", "w1"],
    ]);
  });

  it("is a no-op when the issue never had a worktree", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product", null);

    expect(calls).toEqual([]);
  });

  it("is a no-op when the worktree's workspace is already closed", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", code: 0 });
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.cleanup("ENG-142", "/repos/product", "/repos/product-ENG-142");

    expect(calls).toEqual([["herdr", "workspace", "list"]]);
  });
});

describe("HerdrDispatcher.dispatch — readonly stages share a per-stage tab", () => {
  it("starts omp interactively, without -p, then submits the command via agent prompt", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("workspace") && argv.includes("create")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspace_id: "w1" } }), stderr: "", code: 0 });
        }
        if (argv.includes("tab") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("tab") && argv.includes("create")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("report-metadata")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handle = await dispatcher.dispatch({
      agent: "foreman-plan",
      issueId: null,
      command: "/foreman:plan project-1",
      dispatchId: "dispatch-1",
      cwd: "/repos/product",
      worktree: null,
    });

    expect(handle.herdr).toEqual({ paneId: "w1:p1", agentName: expect.any(String) });
    expect(calls.some((call) => call.includes("split"))).toBe(false);
    const tabCreateCall = calls.find((call) => call.includes("create") && call.includes("tab"));
    expect(tabCreateCall).toEqual([
      "herdr",
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repos/product",
      "--label",
      "plan",
      "--no-focus",
      "--env",
      "FOREMAN_DISPATCH_ID=dispatch-1",
    ]);
    const startCall = calls.find((call) => call.includes("start"));
    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(startCall).toBeDefined();
    expect(startCall).not.toContain("-p");
    expect(startCall?.slice(-1)).not.toEqual(["/foreman:plan project-1"]);
    expect(promptCall).toEqual([
      "herdr",
      "agent",
      "prompt",
      expect.any(String),
      "/foreman:plan project-1",
      "--wait",
      "--until",
      "working",
      "--until",
      "done",
      "--timeout",
      "30000",
    ]);
  });

  it("closes the pane and rethrows when omp never reaches interactive readiness", async () => {
    const runner = {
      run(argv: string[]) {
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product" } }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("tab") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("tab") && argv.includes("create")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "", stderr: "agent_not_ready", code: 1 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await expect(
      dispatcher.dispatch({
        agent: "foreman-plan",
        issueId: null,
        command: "/foreman:plan project-1",
        dispatchId: "dispatch-1",
        cwd: "/repos/product",
        worktree: null,
      }),
    ).rejects.toThrow(/agent_not_ready/);
  });

  it("splits a fresh pane off the shared stage tab's anchor pane, not the tab id, when a second agent for the same stage is already running", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product" } }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("tab") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { tabs: [{ label: "plan", tab_id: "w1:t1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("split")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("report-metadata")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.dispatch({
      agent: "foreman-plan",
      issueId: "project-2",
      command: "/foreman:plan project-2",
      dispatchId: "dispatch-2",
      cwd: "/repos/product",
      worktree: null,
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("w1:p1");
    expect(splitCall).not.toContain("w1:t1");
  });
});

describe("HerdrDispatcher.dispatch — writing stages get a dedicated worktree workspace", () => {
  const worktree = { path: "/repos/product-ENG-142", branch: "eng-142-fix", baseBranch: "main" };

  it("creates a worktree-backed workspace, replacing its plain root pane with a properly-enved one", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("workspace") && argv.includes("create")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspace_id: "w1" } }), stderr: "", code: 0 });
        }
        if (argv.includes("worktree") && argv.includes("create")) {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: { workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } },
            }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("split")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { pane_id: "w2:p2" } } }), stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("report-metadata")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handle = await dispatcher.dispatch({
      agent: "foreman-implement",
      issueId: "ENG-142",
      command: "/foreman:implement ENG-142",
      dispatchId: "dispatch-1",
      cwd: "/repos/product",
      worktree,
    });

    expect(handle.herdr).toEqual({ paneId: "w2:p2", agentName: expect.any(String) });
    const worktreeCreateCall = calls.find((call) => call.includes("worktree") && call.includes("create"));
    expect(worktreeCreateCall).toEqual([
      "herdr",
      "worktree",
      "create",
      "--workspace",
      "w1",
      "--branch",
      "eng-142-fix",
      "--base",
      "main",
      "--path",
      "/repos/product-ENG-142",
      "--label",
      "ENG-142",
      "--no-focus",
    ]);
    expect(calls.some((call) => call.includes("tab") && call.includes("create"))).toBe(false);
    const closeCall = calls.find((call) => call.includes("pane") && call.includes("close"));
    expect(closeCall).toEqual(["herdr", "pane", "close", "w2:p1"]);
  });

  it("reuses an already-open worktree workspace by splitting off its anchor pane", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: {
                workspaces: [
                  { workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product" } },
                  { workspace_id: "w2", active_tab_id: "w2:t1", worktree: { checkout_path: worktree.path } },
                ],
              },
            }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { panes: [{ pane_id: "w2:p1", tab_id: "w2:t1" }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("split")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { pane_id: "w2:p3" } } }), stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("report-metadata")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handle = await dispatcher.dispatch({
      agent: "foreman-implement",
      issueId: "ENG-142",
      command: "/foreman:implement ENG-142 (retry)",
      dispatchId: "dispatch-2",
      cwd: "/repos/product",
      worktree,
    });

    expect(handle.herdr?.paneId).toBe("w2:p3");
    expect(calls.some((call) => call.includes("worktree") && (call.includes("create") || call.includes("open")))).toBe(
      false,
    );
    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("w2:p1");
  });

  it("falls back to opening an existing-on-disk worktree when create reports worktree_create_failed", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("workspace") && argv.includes("create")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { workspace_id: "w1" } }), stderr: "", code: 0 });
        }
        if (argv.includes("worktree") && argv.includes("create")) {
          return Promise.resolve({
            stdout: "",
            stderr: JSON.stringify({ error: { code: "worktree_create_failed", message: "already exists" } }),
            code: 1,
          });
        }
        if (argv.includes("worktree") && argv.includes("open")) {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: { workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } },
            }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("split")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { pane_id: "w2:p2" } } }), stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("start")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("report-metadata")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handle = await dispatcher.dispatch({
      agent: "foreman-implement",
      issueId: "ENG-142",
      command: "/foreman:implement ENG-142",
      dispatchId: "dispatch-3",
      cwd: "/repos/product",
      worktree,
    });

    expect(handle.herdr?.paneId).toBe("w2:p2");
    const openCall = calls.find((call) => call.includes("worktree") && call.includes("open"));
    expect(openCall).toEqual([
      "herdr",
      "worktree",
      "open",
      "--workspace",
      "w1",
      "--path",
      "/repos/product-ENG-142",
      "--label",
      "ENG-142",
      "--no-focus",
    ]);
  });
});

describe("HerdrDispatcher.settle — pane pruning", () => {
  it("closes a readonly stage's pane once its agent settles", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("agent") && argv.includes("wait")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const outcome = await dispatcher.settle({
      dispatchId: "dispatch-1",
      agent: "foreman-plan",
      issueId: null,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: { paneId: "w1:p1", agentName: "foreman-dispatch-1" },
    });

    expect(outcome.status).toBe("settled");
    expect(calls).toContainEqual(["herdr", "pane", "close", "w1:p1"]);
  });

  it("leaves a writing dispatch's pane open once it settles — post-merge cleanup closes it instead", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("agent") && argv.includes("wait")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.settle({
      dispatchId: "dispatch-1",
      agent: "foreman-implement",
      issueId: "ENG-142",
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: { paneId: "w2:p2", agentName: "foreman-dispatch-1" },
    });

    expect(calls.some((call) => call.includes("close"))).toBe(false);
  });
});
