/**
 * `HerdrDispatcher` (SPEC §17.2, §17.3).
 *
 * A real terminal pane per agent, live state, and the ability to attach and
 * take over. Layout: one workspace per repo (the instance and its bound
 * initiatives from the registry, §3.11), one tab per in-flight issue named
 * for the issue, one pane per agent with `--cwd` set to the issue's
 * worktree, and a `foreman` workspace holding the board and `foreman
 * intake` panes and a scratch tab for the worktree-less triage/refine/review
 * agents — each repo workspace holds its own `foreman loop` pane.
 *
 * Everything herdr returns is read from its own JSON output — ids are never
 * predicted, because `pane move` changes a pane's qualified id and only the
 * returned JSON carries the new one.
 *
 * Agent state (`working`/`idle`/`blocked`/…) is never read here as a routing
 * input (SPEC §17.3) — this class only starts and locates panes/tabs/agents.
 * `nextAction` decisions come from Linear alone, in `packages/loop`.
 */

import { execFile } from "node:child_process";
import type { GlobalConfig } from "../config/schema.ts";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
} from "./types.ts";

interface HerdrRunner {
  run(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

const nodeHerdrRunner: HerdrRunner = {
  run(argv) {
    const [command, ...args] = argv;
    const { promise, resolve, reject } = Promise.withResolvers<{
      stdout: string;
      stderr: string;
      code: number;
    }>();
    if (!command) {
      reject(new Error("empty argv"));
      return promise;
    }
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      const code = error ? ((error.code as number | undefined) ?? 1) : 0;
      resolve({ stdout, stderr, code });
    });
    return promise;
  },
};

interface HerdrWorkspaceListResult {
  result: {
    workspaces: { label: string; workspace_id: string }[];
  };
}
interface HerdrTabListResult {
  result: {
    tabs: { label: string; tab_id: string }[];
  };
}
interface HerdrTabResult {
  result: { tab: { tab_id: string } };
}
interface HerdrPaneResult {
  result: { root_pane?: { pane_id: string }; pane?: { pane_id: string } };
}
interface HerdrMoveResult {
  result: { move_result: { pane: { pane_id: string }; previous_pane_id: string } };
}

/**
 * Agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents.
 * Keep the tail when truncating: batch dispatch ids carry their random suffix
 * there, while their common timestamp-heavy prefix is not distinguishing.
 */
export function herdrAgentName(issueId: string): string {
  const suffix = issueId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `foreman-${suffix.slice(-(32 - "foreman-".length))}`;
}

let seqCounter = 0;

export class HerdrDispatcher implements Dispatcher {
  readonly kind = "herdr" as const;

  readonly #config: GlobalConfig;
  readonly #runner: HerdrRunner;

  constructor(config: GlobalConfig, options?: { runner?: HerdrRunner }) {
    this.#config = config;
    this.#runner = options?.runner ?? nodeHerdrRunner;
  }

  async available(): Promise<boolean> {
    try {
      const { code } = await this.#runner.run([this.#config.agent.herdrBin, "workspace", "list"]);
      return code === 0;
    } catch {
      return false;
    }
  }
  async #ensureWorkspace(repoPath: string): Promise<string> {
    // Maps save a little parsing within one process, but are insufficient for
    // a loop restarted around existing Herdr state. Re-read Herdr's own list
    // first so "one workspace per repo" holds across process lifetimes.
    const { stdout } = await this.#runner.run([
      this.#config.agent.herdrBin,
      "workspace",
      "list",
    ]);
    const listed = JSON.parse(stdout) as HerdrWorkspaceListResult;
    const existing = listed.result.workspaces.find((workspace) => workspace.label === repoPath);
    if (existing) {
      return existing.workspace_id;
    }

    const created = await this.#runner.run([
      this.#config.agent.herdrBin,
      "workspace",
      "create",
      "--label",
      repoPath,
      "--no-focus",
    ]);
    const parsed = JSON.parse(created.stdout) as { result: { workspace_id: string } };
    const workspaceId = parsed.result.workspace_id;
    return workspaceId;
  }

  async #ensureTab(workspaceId: string, label: string, cwd: string): Promise<string> {
    // Like workspaces, tabs outlive this dispatcher instance. A process restart
    // must locate the prior tab by its stable issue label rather than create a
    // duplicate for every resumed dispatch.
    const { stdout } = await this.#runner.run([
      this.#config.agent.herdrBin,
      "tab",
      "list",
      "--workspace",
      workspaceId,
    ]);
    const listed = JSON.parse(stdout) as HerdrTabListResult;
    const existing = listed.result.tabs.find((tab) => tab.label === label);
    if (existing) {
      return existing.tab_id;
    }

    const created = await this.#runner.run([
      this.#config.agent.herdrBin,
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ]);
    const parsed = JSON.parse(created.stdout) as HerdrTabResult;
    const tabId = parsed.result.tab.tab_id;
    return tabId;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle> {
    const label = request.issueId ?? "scratch";
    const workspaceId = await this.#ensureWorkspace(request.cwd);
    const tabId = await this.#ensureTab(workspaceId, label, request.cwd);

    const paneResult = await this.#runner.run([
      this.#config.agent.herdrBin,
      "pane",
      "split",
      "--pane",
      tabId,
      "--direction",
      "down",
      "--cwd",
      request.cwd,
    ]);
    const parsedPane = JSON.parse(paneResult.stdout) as HerdrPaneResult;
    const paneId = parsedPane.result.pane?.pane_id ?? parsedPane.result.root_pane?.pane_id;
    if (!paneId) {
      throw new Error(`herdr pane split returned no pane id: ${paneResult.stdout}`);
    }

    const agentName = herdrAgentName(request.issueId ?? request.dispatchId);
    await this.#runner.run([
      this.#config.agent.herdrBin,
      "agent",
      "start",
      agentName,
      "--kind",
      "omp",
      "--pane",
      paneId,
      "--timeout",
      "30000",
      "--",
      "-p",
      "--approval-mode",
      this.#config.agent.approvalMode,
      "--cwd",
      request.cwd,
      request.command,
    ]);

    seqCounter += 1;
    await this.#runner.run([
      this.#config.agent.herdrBin,
      "pane",
      "report-metadata",
      paneId,
      "--source",
      "foreman",
      "--token",
      `issue=${request.issueId ?? "batch"}`,
      "--token",
      `agent=${request.agent}`,
      "--seq",
      String(seqCounter),
      "--ttl-ms",
      String(this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs),
    ]);


    return {
      dispatchId: request.dispatchId,
      agent: request.agent,
      issueId: request.issueId,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: { paneId, agentName },
    };
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    if (!handle.herdr) return "lost";
    try {
      const { stdout, code } = await this.#runner.run([
        this.#config.agent.herdrBin,
        "agent",
        "get",
        handle.herdr.agentName,
      ]);
      if (code !== 0) return "lost";
      const parsed = JSON.parse(stdout) as { result: { status: string } };
      // Herdr's classification is a UI signal only (SPEC §17.3) — mapped here
      // to the Dispatcher's coarse starting/running/settled/lost vocabulary,
      // never fed back into a routing decision.
      switch (parsed.result.status) {
        case "done":
          return "settled";
        case "unknown":
          return "lost";
        default:
          return "running";
      }
    } catch {
      return "lost";
    }
  }

  /**
   * Herdr is not the results channel (SPEC §17.3): the loop reads Linear, not
   * panes. `settle` exists to satisfy the interface uniformly with
   * `PrintDispatcher`; it waits for the herdr agent to leave `working` and
   * returns an empty log, never scraping pane content.
   */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    if (!handle.herdr) {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
    const timeoutMs = this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs;
    try {
      const { code } = await this.#runner.run([
        this.#config.agent.herdrBin,
        "agent",
        "wait",
        handle.herdr.agentName,
        "--until",
        "done",
        "--timeout",
        String(timeoutMs),
      ]);
      return {
        handle,
        status: code === 0 ? "settled" : "lost",
        exitCode: code,
        log: "",
      };
    } catch {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
  }

  async attach(handle: DispatchHandle): Promise<void> {
    if (!handle.herdr) return;
    await this.#runner.run([this.#config.agent.herdrBin, "agent", "focus", handle.herdr.agentName]);
  }

  /**
   * Re-reads a pane id after a move, per SPEC §17.3: moving a pane between
   * workspaces or tabs changes its qualified id, and the caller must never
   * predict the new one.
   */
  async movePane(paneId: string, targetTabId: string): Promise<string> {
    const { stdout } = await this.#runner.run([
      this.#config.agent.herdrBin,
      "pane",
      "move",
      paneId,
      "--tab",
      targetTabId,
      "--split",
      "down",
    ]);
    const parsed = JSON.parse(stdout) as HerdrMoveResult;
    return parsed.result.move_result.pane.pane_id;
  }
}
