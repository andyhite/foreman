import { describe, expect, it } from "bun:test";
import type { DispatchHandle, DispatchItem, GlobalConfig } from "@foreman/core";
import { OrchestratorBusyError, isOrchestratorBusy } from "../src/dispatch/busy.ts";
import {
  HerdrDispatcher,
  HerdrUnavailableError,
  herdrAgentName,
  isHerdrUnavailable,
  sharedAgentName,
} from "../src/dispatch/herdr.ts";

function makeConfig(overrides: { herdrLayout?: "tab" | "pane" } = {}): GlobalConfig {
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
    agent: {
      maxRuntimeMs: 7_200_000,
      lockTtlMarginMs: 1_800_000,
      ompBin: "omp",
      approvalMode: "yolo",
      herdrBin: "herdr",
      herdrLayout: overrides.herdrLayout ?? "tab",
      orchestratorMaxBatches: 20,
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

describe("sharedAgentName", () => {
  it("keys the name off alias and stage, fitting herdr's 32-char limit", () => {
    expect(sharedAgentName("product", "foreman-refine")).toBe("foreman-product-refine");
    const long = sharedAgentName("a-very-long-repository-alias-name", "foreman-review");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-review")).toBe(true);
    expect(long.startsWith("foreman-")).toBe(true);
  });
});

function readonlyDispatchRunner(agentGet: { code: number; stdout?: string }) {
  const calls: string[][] = [];
  const runner = {
    run(argv: string[]) {
      calls.push(argv);
      if (argv.includes("agent") && argv.includes("get")) {
        return Promise.resolve({ stdout: agentGet.stdout ?? "", stderr: "", code: agentGet.code });
      }
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

describe("HerdrDispatcher.dispatch — shared per-stage orchestrator", () => {
  it("starts a fresh shared orchestrator and submits every item's subject in one prompt", async () => {
    const { calls, runner } = readonlyDispatchRunner({ code: 1 });
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
    expect(handles[0]!.batchId).toBe(handles[1]!.batchId);
    expect(handles[0]!.herdr).toEqual({ paneId: "w1:p1", agentName: "foreman-product-refine" });
    expect(handles[1]!.herdr).toEqual({ paneId: "w1:p1", agentName: "foreman-product-refine" });
    expect(handles.map((h) => h.issueId)).toEqual(["ENG-1", "ENG-2"]);

    const startCall = calls.find((call) => call.includes("start"));
    expect(startCall).toBeDefined();
    expect(startCall).toContain("foreman-product-refine");
    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(promptCall).toEqual([
      "herdr",
      "agent",
      "prompt",
      "foreman-product-refine",
      "/foreman:refine ENG-1 ENG-2",
      "--wait",
      "--until",
      "working",
      "--timeout",
      "30000",
    ]);
  });

  it("prompts the bare command when the only item's subject is null", async () => {
    const { calls, runner } = readonlyDispatchRunner({ code: 1 });
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

  it("reuses a live shared orchestrator without starting a second agent", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "idle", pane_id: "w1:p9" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    });

    expect(handles[0]!.herdr).toEqual({ paneId: "w1:p9", agentName: "foreman-product-refine" });
    expect(calls.some((call) => call.includes("agent") && call.includes("start"))).toBe(false);
    expect(calls.some((call) => call.includes("tab") && call.includes("create"))).toBe(false);
    const promptCall = calls.find((call) => call.includes("prompt"));
    expect(promptCall).toBeDefined();
  });

  it("reuses a live shared orchestrator that is done, the same as idle", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "done", pane_id: "w1:p9" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    });

    expect(handles[0]!.herdr?.paneId).toBe("w1:p9");
    expect(calls.some((call) => call.includes("agent") && call.includes("start"))).toBe(false);
  });

  it("throws OrchestratorBusyError when the shared orchestrator is working, without prompting it", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "working", pane_id: "w1:p9" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const dispatchRequest = {
      agent: "foreman-refine" as const,
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    };
    await expect(dispatcher.dispatch(dispatchRequest)).rejects.toThrow(OrchestratorBusyError);
    try {
      await dispatcher.dispatch(dispatchRequest);
      throw new Error("expected dispatch to reject");
    } catch (error) {
      expect(isOrchestratorBusy(error)).toBe(true);
    }
    expect(calls.some((call) => call.includes("prompt"))).toBe(false);
  });

  it("throws a plain error when the shared orchestrator is blocked", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "blocked", pane_id: "w1:p9" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const dispatchRequest = {
      agent: "foreman-refine" as const,
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    };
    await expect(dispatcher.dispatch(dispatchRequest)).rejects.toThrow(/blocked/);
    try {
      await dispatcher.dispatch(dispatchRequest);
      throw new Error("expected dispatch to reject");
    } catch (error) {
      expect(isOrchestratorBusy(error)).toBe(false);
    }
    expect(calls.some((call) => call.includes("prompt"))).toBe(false);
  });

  it("throws a plain error when the shared orchestrator is blocked", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "blocked", pane_id: "w1:p9" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const rejection = dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    });
    await expect(rejection).rejects.toThrow(/blocked/);
    await expect(rejection).rejects.toSatisfy((error) => !isOrchestratorBusy(error));
    expect(calls.some((call) => call.includes("prompt"))).toBe(false);
  });

  it("discards a stale unknown-status agent's pane and starts fresh", async () => {
    const { calls, runner } = readonlyDispatchRunner({
      code: 0,
      stdout: JSON.stringify({ result: { agent: { agent_status: "unknown", pane_id: "w1:p-stale" } } }),
    });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-3", subject: "ENG-3", dispatchId: "dispatch-3" })],
    });

    expect(handles[0]!.herdr?.paneId).toBe("w1:p1");
    const closeCall = calls.find((call) => call.includes("pane") && call.includes("close"));
    expect(closeCall).toEqual(["herdr", "pane", "close", "w1:p-stale"]);
    expect(calls.some((call) => call.includes("agent") && call.includes("start"))).toBe(true);
  });

  it("closes the freshly created pane and rethrows when omp never reaches interactive readiness", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("agent") && argv.includes("get")) {
          return Promise.resolve({ stdout: "", stderr: "", code: 1 });
        }
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
        command: "/foreman:plan",
        cwd: "/repos/product",
        alias: "product",
        items: [item({ subject: "project-1", dispatchId: "dispatch-1" })],
      }),
    ).rejects.toThrow(/agent_not_ready/);
    expect(calls.some((call) => call.includes("pane") && call.includes("close"))).toBe(true);
  });

  it("never closes a reused shared pane on prompt failure", async () => {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("agent") && argv.includes("get")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { agent: { agent_status: "idle", pane_id: "w1:p9" } } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product" } }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("agent") && argv.includes("prompt")) {
          return Promise.resolve({ stdout: "", stderr: "agent_prompt_failed", code: 1 });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner });

    await expect(
      dispatcher.dispatch({
        agent: "foreman-refine",
        command: "/foreman:refine",
        cwd: "/repos/product",
        alias: "product",
        items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
      }),
    ).rejects.toThrow(/agent_prompt_failed/);
    expect(calls.some((call) => call.includes("pane") && call.includes("close"))).toBe(false);
  });
});

describe("HerdrDispatcher.dispatch — agent.herdrLayout: \"pane\"", () => {
  const CALLER_ENV = { HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" };

  function paneLayoutRunner(tabPanes: { pane_id: string; tab_id: string; label?: string }[]) {
    const calls: string[][] = [];
    const runner = {
      run(argv: string[]) {
        calls.push(argv);
        if (argv.includes("agent") && argv.includes("get")) {
          return Promise.resolve({ stdout: "", stderr: "", code: 1 });
        }
        if (argv.includes("workspace") && argv.includes("list")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", worktree: { checkout_path: "/repos/product" } }] } }),
            stderr: "",
            code: 0,
          });
        }
        if (argv.includes("pane") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { panes: tabPanes } }), stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("split")) {
          const newPaneId = `w1:p${calls.length}`;
          return Promise.resolve({ stdout: JSON.stringify({ result: { pane: { pane_id: newPaneId } } }), stderr: "", code: 0 });
        }
        if (argv.includes("pane") && argv.includes("rename")) {
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
        if (argv.includes("tab") && argv.includes("list")) {
          return Promise.resolve({ stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "", code: 0 });
        }
        if (argv.includes("tab") && argv.includes("create")) {
          return Promise.resolve({
            stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }),
            stderr: "",
            code: 0,
          });
        }
        throw new Error(`unexpected herdr call: ${argv.join(" ")}`);
      },
    };
    return { calls, runner };
  }

  it("splits the caller's own pane right to open the column's first row", async () => {
    const { calls, runner } = paneLayoutRunner([{ pane_id: "w1:p1", tab_id: "w1:t1" }]);
    const dispatcher = new HerdrDispatcher(makeConfig({ herdrLayout: "pane" }), { runner, env: CALLER_ENV });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toEqual([
      "herdr", "pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/repos/product",
      "--env", "FOREMAN_DISPATCH_ID=dispatch-1",
    ]);
    const renameCall = calls.find((call) => call.includes("rename"));
    expect(renameCall?.slice(-1)[0]).toBe("foreman-refine");
    expect(calls.some((call) => call.includes("tab") && call.includes("create"))).toBe(false);
    expect(handles[0]!.herdr?.paneId).toBe(renameCall?.[3]);
  });

  it("stacks a new stage's row below an existing column row instead of opening a second column", async () => {
    const { calls, runner } = paneLayoutRunner([
      { pane_id: "w1:p1", tab_id: "w1:t1" },
      { pane_id: "w1:p5", tab_id: "w1:t1", label: "foreman-plan" },
    ]);
    const dispatcher = new HerdrDispatcher(makeConfig({ herdrLayout: "pane" }), { runner, env: CALLER_ENV });

    await dispatcher.dispatch({
      agent: "foreman-review",
      command: "/foreman:review",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    const splitCall = calls.find((call) => call.includes("split"));
    expect(splitCall).toEqual([
      "herdr", "pane", "split", "--pane", "w1:p5", "--direction", "down", "--cwd", "/repos/product",
      "--env", "FOREMAN_DISPATCH_ID=dispatch-1",
    ]);
    const renameCall = calls.find((call) => call.includes("rename"));
    expect(renameCall?.slice(-1)[0]).toBe("foreman-review");
  });

  it("falls back to the tab strategy when the loop is not running inside a herdr pane", async () => {
    const { calls, runner } = paneLayoutRunner([]);
    const dispatcher = new HerdrDispatcher(makeConfig({ herdrLayout: "pane" }), { runner, env: {} });

    const handles = await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    expect(calls.some((call) => call.includes("tab") && call.includes("create"))).toBe(true);
    expect(calls.some((call) => call.includes("pane") && call.includes("split"))).toBe(false);
    expect(handles[0]!.herdr).toEqual({ paneId: "w1:p2", agentName: "foreman-product-refine" });
  });
});

describe("HerdrDispatcher.dispatch — env passthrough", () => {
  it("sets FOREMAN_DISPATCH_ID and FOREMAN_DISPATCH_RESERVATIONS for a single-item request", async () => {
    const { calls, runner } = readonlyDispatchRunner({ code: 1 });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner, reservationsDir: "/state/reservations" });

    await dispatcher.dispatch({
      agent: "foreman-refine",
      command: "/foreman:refine",
      cwd: "/repos/product",
      alias: "product",
      items: [item({ issueId: "ENG-1", subject: "ENG-1", dispatchId: "dispatch-1" })],
    });

    const tabCreateCall = calls.find((call) => call.includes("tab") && call.includes("create"));
    expect(tabCreateCall).toContain("FOREMAN_DISPATCH_ID=dispatch-1");
    expect(tabCreateCall).toContain("FOREMAN_DISPATCH_RESERVATIONS=/state/reservations/foreman-refine.json");
  });

  it("omits FOREMAN_DISPATCH_ID but keeps FOREMAN_DISPATCH_RESERVATIONS for a multi-item batch", async () => {
    const { calls, runner } = readonlyDispatchRunner({ code: 1 });
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner, reservationsDir: "/state/reservations" });

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

    const tabCreateCall = calls.find((call) => call.includes("tab") && call.includes("create"));
    expect(tabCreateCall?.some((arg) => arg.startsWith("FOREMAN_DISPATCH_ID="))).toBe(false);
    expect(tabCreateCall).toContain("FOREMAN_DISPATCH_RESERVATIONS=/state/reservations/foreman-refine.json");
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
    batchId: "batch-1",
    pid: null,
    herdr: { paneId: "w1:p1", agentName: "foreman-product-plan" },
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
    const config = makeConfig();
    config.agent.orchestratorMaxBatches = 1;
    const dispatcher = new HerdrDispatcher(config, { runner });

    const outcome = await dispatcher.settle(makeHandle({}));

    expect(outcome.status).toBe("settled");
    expect(calls).toContainEqual(["herdr", "pane", "close", "w1:p1"]);
    const waitCall = calls.find((call) => call.includes("wait"));
    expect(waitCall).toEqual(["herdr", "agent", "wait", "foreman-product-plan", "--until", "idle", "--until", "done", "--timeout", String(9_000_000)]);
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

    await dispatcher.settle(
      makeHandle({
        agent: "foreman-implement",
        issueId: "ENG-142",
        herdr: { paneId: "w2:p2", agentName: "foreman-dispatch-1" },
      }),
    );

    expect(calls.some((call) => call.includes("close"))).toBe(false);
  });

  it("shares one agent wait between two sibling handles of the same batch", async () => {
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

    const handleA = makeHandle({ dispatchId: "dispatch-a", issueId: "ENG-1" });
    const handleB = makeHandle({ dispatchId: "dispatch-b", issueId: "ENG-2" });

    const [outcomeA, outcomeB] = await Promise.all([dispatcher.settle(handleA), dispatcher.settle(handleB)]);

    expect(waitCalls).toBe(1);
    expect(outcomeA.handle).toBe(handleA);
    expect(outcomeB.handle).toBe(handleB);
    expect(outcomeA.status).toBe("settled");
    expect(outcomeB.status).toBe("settled");
  });

  it("closes a shared orchestrator's pane exactly at the recycle threshold, not before", async () => {
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
    const config = makeConfig();
    config.agent.orchestratorMaxBatches = 2;
    const dispatcher = new HerdrDispatcher(config, { runner });

    await dispatcher.settle(makeHandle({ batchId: "batch-1" }));
    expect(calls.some((call) => call.includes("pane") && call.includes("close"))).toBe(false);

    await dispatcher.settle(makeHandle({ batchId: "batch-2" }));
    expect(calls.some((call) => call.includes("pane") && call.includes("close"))).toBe(true);
  });

  it("returns lost when the handle has no herdr pane", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    const outcome = await dispatcher.settle(makeHandle({ herdr: null }));
    expect(outcome.status).toBe("lost");
  });
});
