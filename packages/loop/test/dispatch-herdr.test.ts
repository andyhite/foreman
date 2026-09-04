import { describe, expect, it } from "bun:test";
import type { DispatchHandle, DispatchItem, GlobalConfig } from "@foreman/core";
import { HerdrDispatcher, HerdrUnavailableError, herdrAgentName, isHerdrUnavailable } from "../src/dispatch/herdr.ts";

function makeConfig(): GlobalConfig {
  return {
    repos: {},
    loop: {
      mode: "confirm",
      cleanupMergedWorktrees: true,
      autoMerge: false,
      retryCap: 2,
      reviewCycleCap: 2,
      stateDir: "~/.foreman/state",
      concurrency: { plan: 1, build: 3 },
      pollSeconds: 20,
      triageBatch: 10,
    },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql", allowCustomEndpoint: false, operatorUserId: null },
    githubApp: { appId: null, privateKeyFile: null },
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
      dispatcher: "auto",
    },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

function item(overrides: Partial<DispatchItem>): DispatchItem {
  return { issueId: null, subject: null, dispatchId: "dispatch-1", worktree: null, ...overrides };
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
        command: "/foreman:refine",
        cwd: "/tmp",
        alias: "product",
        items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
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

/** A fake runner for the "loop tab + fresh pane" dispatch path. `tabExists` controls whether `tab list` already reports the loop's tab. */
function loopDispatchRunner(options: { tabExists: boolean } = { tabExists: false }) {
  const calls: string[][] = [];
  let splitCount = 0;
  let tabCreated = options.tabExists;
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
          stdout: JSON.stringify({ result: { tabs: tabCreated ? [{ label: "product-refine", tab_id: "w1:t1" }] : [] } }),
          stderr: "",
          code: 0,
        });
      }
      if (argv.includes("tab") && argv.includes("create")) {
        tabCreated = true;
        return Promise.resolve({
          stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p0" } } }),
          stderr: "",
          code: 0,
        });
      }
      if (argv.includes("pane") && argv.includes("list")) {
        return Promise.resolve({ stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p0", tab_id: "w1:t1" }] } }), stderr: "", code: 0 });
      }
      if (argv.includes("pane") && argv.includes("split")) {
        splitCount += 1;
        return Promise.resolve({
          stdout: JSON.stringify({ result: { pane: { pane_id: `w1:p${splitCount}` } } }),
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
      if (argv.includes("pane") && argv.includes("close")) {
        return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
      }
      throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
    },
  };
  return { calls, runner };
}

describe("HerdrDispatcher.dispatch — one pane per dispatch", () => {
  it("creates the loop's tab and starts a fresh agent in a pane split off its anchor, submitting every item's subject in one prompt", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [
        item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" }),
        item({ issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2" }),
      ],
    });

    expect(handles).toHaveLength(2);
    expect(handles[0]!.herdr).toEqual({ paneId: "w1:p1", agentName: herdrAgentName("dispatch-1") });
    expect(handles[1]!.herdr).toEqual({ paneId: "w1:p1", agentName: herdrAgentName("dispatch-1") });
    expect(handles.map((h) => h.issueId)).toEqual(["ENG-1", "ENG-2"]);

    const tabCreateCall = calls.find((call) => call.includes("tab") && call.includes("create"));
    expect(tabCreateCall).toContain("product-refine");
    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("w1:p0");
    const startCall = calls.find((call) => call.includes("start"));
    expect(startCall).toContain(herdrAgentName("dispatch-1"));
    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(promptCall).toEqual([
      "herdr",
      "agent",
      "prompt",
      herdrAgentName("dispatch-1"),
      "/foreman:refine ENG-1 ENG-2",
      "--wait",
      "--until",
      "working",
      "--until",
      "done",
      "--timeout",
      "30000",
    ]);
  });

  it("prompts the bare command when the only item's subject is null", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.dispatch({
      agent: "foreman-triage",
      command: "/foreman:triage",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ dispatchId: "dispatch-1" })],
    });

    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(promptCall?.[4]).toBe("/foreman:triage");
  });

  it("gives two independent dispatches to the same loop each their own pane, split off the tab's anchor", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const first = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });
    const second = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2" })],
    });

    expect(first[0]!.herdr?.paneId).not.toBe(second[0]!.herdr?.paneId);
    expect(calls.filter((call) => call.includes("tab") && call.includes("create"))).toHaveLength(1);
    const splitCalls = calls.filter((call) => call.includes("split"));
    expect(splitCalls).toHaveLength(2);
    // Both splits are off the same tab anchor pane — the second dispatch never
    // reuses the first dispatch's already-settled pane as its split source.
    expect(splitCalls[0]).toContain("w1:p0");
    expect(splitCalls[1]).toContain("w1:p0");
  });

  it("reuses an existing loop tab across dispatches, splitting a fresh pane off its anchor each time", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: true });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    });

    expect(calls.some((call) => call.includes("tab") && call.includes("create"))).toBe(false);
    expect(handles[0]!.herdr?.paneId).toBe("w1:p1");
  });

  it("sets FOREMAN_DISPATCH_ID for a single-item request", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("FOREMAN_DISPATCH_ID=dispatch-1");
  });

  it("omits FOREMAN_DISPATCH_ID for a multi-item batch", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [
        item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" }),
        item({ issueId: "ENG-2", subject: "ENG-2", dispatchId: "dispatch-2" }),
      ],
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall?.some((arg) => arg.startsWith("FOREMAN_DISPATCH_ID="))).toBe(false);
  });

  it("scrubs configured credential env vars via --env NAME= on the split pane", async () => {
    const { calls, runner } = loopDispatchRunner({ tabExists: false });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner, scrubEnv: ["LINEAR_API_KEY"] });

    await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("--env");
    expect(splitCall).toContain("LINEAR_API_KEY=");
    // Scrubbing clears the value rather than omitting the var — no call embeds a live secret.
    expect(splitCall?.some((arg) => /^LINEAR_API_KEY=.+/.test(arg))).toBe(false);
  });

  it("closes the freshly created pane and rethrows when omp never reaches interactive readiness", async () => {
    const { calls, runner: baseRunner } = loopDispatchRunner({ tabExists: false });
    const runner = {
      run(argv: string[]) {
        if (argv.includes("agent") && argv.includes("start")) {
          calls.push(argv);
          return Promise.resolve({ stdout: "", stderr: "agent_not_ready", code: 1 });
        }
        return baseRunner.run(argv);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await expect(
      dispatcher.dispatch({
        agent: "foreman-plan",
        command: "/foreman:plan",
        cwd: "/repos/product",
        alias: "product",
        items: [item({ subject: "project-1", dispatchId: "dispatch-1" })],
      }),
    ).rejects.toThrow(/agent_not_ready/);
    expect(calls.some((call) => call.includes("agent") && call.includes("start"))).toBe(true);
  });
});

describe("HerdrDispatcher.dispatch — writing stages get a dedicated worktree workspace", () => {
  const worktree = { path: "/repos/product-ENG-142", branch: "eng-142-fix", baseBranch: "main" };

  it("creates a worktree-backed workspace, replacing its plain root pane with a properly-enved one, using a per-dispatch agent name", async () => {
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

    const handles = await dispatcher.dispatch({
      agent: "foreman-implement",
      command: "/foreman:implement",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-1", worktree })],
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]!.herdr).toEqual({ paneId: "w2:p2", agentName: herdrAgentName("dispatch-1") });
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
    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(promptCall?.[4]).toBe("/foreman:implement ENG-142");
  });

  it("starts the omp session with --cwd pointed at the worktree, not the repo root", async () => {
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

    await dispatcher.dispatch({
      agent: "foreman-implement",
      command: "/foreman:implement",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-4", worktree })],
    });

    const startCall = calls.find((call) => call.includes("agent") && call.includes("start"));
    const cwdIndex = startCall?.indexOf("--cwd") ?? -1;
    expect(cwdIndex).toBeGreaterThan(-1);
    expect(startCall?.[cwdIndex + 1]).toBe(worktree.path);
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
        if (argv.includes("pane") && argv.includes("get")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { agent_status: "idle" } } }), stderr: "", code: 0 });
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

    const handles = await dispatcher.dispatch({
      agent: "foreman-implement",
      command: "/foreman:implement",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-2", worktree })],
    });

    expect(handles[0]!.herdr?.paneId).toBe("w2:p3");
    expect(calls.some((call) => call.includes("worktree") && (call.includes("create") || call.includes("open")))).toBe(
      false,
    );
    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toContain("w2:p1");
  });

  it("refuses to replace a worktree pane still hosting a working agent", async () => {
    const runner = {
      run(argv: string[]) {
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
        if (argv.includes("pane") && argv.includes("get")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { agent_status: "working" } } }), stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await expect(
      dispatcher.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: "/repos/product",
        alias: "product",
        items: [item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-2", worktree })],
      }),
    ).rejects.toThrow(/still hosts a working agent/);
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

    const handles = await dispatcher.dispatch({
      agent: "foreman-implement",
      command: "/foreman:implement",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-3", worktree })],
    });

    expect(handles[0]!.herdr?.paneId).toBe("w2:p2");
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

  it("throws when a worktree item is mixed with another item in one request", async () => {
    const runner = {
      run(argv: string[]) {
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await expect(
      dispatcher.dispatch({
        agent: "foreman-implement",
        command: "/foreman:implement",
        cwd: "/repos/product",
        alias: "product",
        items: [
          item({ issueId: "ENG-142", subject: "ENG-142", dispatchId: "dispatch-1", worktree }),
          item({ issueId: "ENG-143", subject: "ENG-143", dispatchId: "dispatch-2" }),
        ],
      }),
    ).rejects.toThrow(/mix/);
  });
});

function makeHandle(overrides: Partial<DispatchHandle>): DispatchHandle {
  return {
    dispatchId: "dispatch-1",
    agent: "foreman-plan",
    issueId: null,
    startedAt: new Date().toISOString(),
    pid: null,
    herdr: { paneId: "w1:p1", agentName: "foreman-dispatch-1" },
    ...overrides,
  };
}

describe("HerdrDispatcher.status", () => {
  const cases: [string, "settled" | "running" | "lost"][] = [
    ["idle", "settled"],
    ["done", "settled"],
    ["working", "running"],
    ["blocked", "running"],
    ["unknown", "lost"],
  ];

  for (const [agentStatus, expected] of cases) {
    it(`maps agent_status "${agentStatus}" to "${expected}"`, async () => {
      const runner = {
        run(argv: string[]) {
          if (argv.includes("agent") && argv.includes("get")) {
            return Promise.resolve({
              stdout: JSON.stringify({ result: { agent: { agent_status: agentStatus } } }),
              stderr: "",
              code: 0,
            });
          }
          throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
        },
      };
      const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

      await expect(dispatcher.status(makeHandle({}))).resolves.toBe(expected);
    });
  }

  it("returns lost when the handle has no herdr pane", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    await expect(dispatcher.status(makeHandle({ herdr: null }))).resolves.toBe("lost");
  });

  it("returns lost on a non-zero agent get exit", async () => {
    const runner = { run: () => Promise.resolve({ stdout: "", stderr: "agent_not_found", code: 1 }) };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });
    await expect(dispatcher.status(makeHandle({}))).resolves.toBe("lost");
  });
});

describe("HerdrDispatcher.settle", () => {
  it("closes a non-worktree dispatch's pane once its agent settles", async () => {
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

    const outcome = await dispatcher.settle(makeHandle({}));

    expect(outcome.status).toBe("settled");
    expect(calls).toContainEqual(["herdr", "pane", "close", "w1:p1"]);
    const waitCall = calls.find((call) => call.includes("wait"));
    expect(waitCall).toEqual([
      "herdr",
      "agent",
      "wait",
      "foreman-dispatch-1",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      String(9_000_000),
    ]);
  });

  it("leaves a worktree dispatch's pane open once it settles — post-merge cleanup closes it instead", async () => {
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

    await dispatcher.settle(
      makeHandle({
        agent: "foreman-implement",
        issueId: "ENG-142",
        herdr: { paneId: "w2:p2", agentName: "foreman-dispatch-1" },
      }),
    );

    expect(calls.some((call) => call.includes("close"))).toBe(false);
  });

  it("shares one agent wait between two sibling handles of the same dispatch", async () => {
    let waitCalls = 0;
    const runner = {
      run(argv: string[]) {
        if (argv.includes("agent") && argv.includes("wait")) {
          waitCalls += 1;
          // Deterministic microtask hop, not a wall-clock timer: proves the
          // second `settle()` call reused this in-flight promise rather than
          // issuing its own `agent wait`.
          return Promise.resolve().then(() => ({ stdout: "{}", stderr: "", code: 0 }));
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const herdr = { paneId: "w1:p1", agentName: "foreman-dispatch-1" };
    const handleA = makeHandle({ dispatchId: "dispatch-a", issueId: "ENG-1", herdr });
    const handleB = makeHandle({ dispatchId: "dispatch-b", issueId: "ENG-2", herdr });

    const [outcomeA, outcomeB] = await Promise.all([dispatcher.settle(handleA), dispatcher.settle(handleB)]);

    expect(waitCalls).toBe(1);
    expect(outcomeA.handle).toBe(handleA);
    expect(outcomeB.handle).toBe(handleB);
    expect(outcomeA.status).toBe("settled");
    expect(outcomeB.status).toBe("settled");
  });

  it("returns lost when the handle has no herdr pane", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    const outcome = await dispatcher.settle(makeHandle({ herdr: null }));
    expect(outcome.status).toBe("lost");
  });

  it("gives the underlying agent wait exec call a timeoutMs greater than maxRuntimeMs + lockTtlMarginMs, so herdr's own --timeout wins the race", async () => {
    const recordedOptions: ({ timeoutMs?: number } | undefined)[] = [];
    const runner = {
      run(argv: string[], options?: { timeoutMs?: number }) {
        if (argv.includes("agent") && argv.includes("wait")) {
          recordedOptions.push(options);
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("close")) {
          return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const config = makeConfig();
    const dispatcher = new HerdrDispatcher(config, { runner });

    await dispatcher.settle(makeHandle({}));

    expect(recordedOptions).toHaveLength(1);
    const ceiling = config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs;
    expect(recordedOptions[0]?.timeoutMs).toBeGreaterThan(ceiling);
  });
});
