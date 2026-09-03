/**
 * `HerdrDispatcher` (SPEC §17.2, §17.3).
 *
 * A real terminal pane per dispatch, live state, and the ability to attach
 * and take over. Layout: one workspace per repo (the instance and its bound
 * initiatives from the registry, §3.11), one tab per loop (readonly
 * stage or writing loop) holding every dispatch that loop has fired, one
 * pane per dispatch — split fresh off that tab's anchor pane every time, so
 * a new dispatch never reuses a pane a prior dispatch already settled — and
 * with `--cwd` set to the issue's worktree for a writing dispatch.
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
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
} from "@foreman/core";
import { BATCH_SUBJECT } from "@foreman/core";

/** Every herdr subprocess gets this ceiling — a hung CLI must not wedge dispatch or settle. */
export const HERDR_EXEC_TIMEOUT_MS = 30_000;

export class HerdrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrUnavailableError";
  }
}

export function isHerdrUnavailable(error: unknown): error is HerdrUnavailableError {
  return error instanceof HerdrUnavailableError;
}

/** A reused workspace still hosts a working/blocked agent — a routine skip, not a failure (SPEC §17.4). */
export class DispatcherBusyError extends Error {}

export function isDispatcherBusy(error: unknown): error is DispatcherBusyError {
  return error instanceof DispatcherBusyError;
}

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
      reject(new HerdrUnavailableError("empty herdr argv"));
      return promise;
    }
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: HERDR_EXEC_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.code === "ETIMEDOUT") {
            reject(
              new HerdrUnavailableError(
                `herdr ${args.join(" ")} timed out after ${HERDR_EXEC_TIMEOUT_MS}ms`,
              ),
            );
            return;
          }
          if (typeof error.code !== "number") {
            reject(new HerdrUnavailableError(`herdr ${args.join(" ")} failed: ${error.message}`));
            return;
          }
        }
        const code = error ? ((error.code as number | undefined) ?? 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
    return promise;
  },
};

interface HerdrWorkspaceListResult {
  result: {
    workspaces: { workspace_id: string; active_tab_id: string; worktree?: { checkout_path: string } }[];
  };
}
interface HerdrTabListResult {
  result: {
    tabs: { label: string; tab_id: string }[];
  };
}
interface HerdrTabResult {
  result: { tab: { tab_id: string }; root_pane: { pane_id: string } };
}
/** Shared by `worktree create` and `worktree open` — both hand back a fresh workspace/tab/pane. */
interface HerdrWorktreeResult {
  result: { workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } };
}
interface HerdrPaneListResult {
  result: { panes: { pane_id: string; tab_id: string; label?: string }[] };
}
interface HerdrPaneResult {
  result: { root_pane?: { pane_id: string }; pane?: { pane_id: string } };
}
/** `herdr pane get` shape — `agent_status` is the only field this class inspects when checking whether a reused worktree workspace's pane still hosts a live agent. */
interface HerdrPaneGetResult {
  result: { pane?: { agent_status?: string } };
}
/** `herdr agent get`/`agent list` shape — `agent_status` is the only field this class inspects (SPEC §17.3). */
interface HerdrAgentResult {
  result: { agent: { agent_status: string; pane_id?: string } };
}
/** Every failed herdr call's stderr is this shape (verified live across `workspace`/`tab`/`pane`/`worktree`). */
interface HerdrErrorResponse {
  error?: { code?: string; message?: string };
}

/**
 * Agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live
 * agents — and herdr keeps a `done` agent's name reserved until its pane is
 * closed (verified live: `agent_name_taken`, even against a finished agent),
 * which for a dispatch doesn't happen until `settle()` closes its pane (or,
 * for a worktree dispatch, until post-merge `cleanup()`). Keying this off
 * `issueId` would collide on every redispatch to the same issue before
 * merge, so it always takes the dispatch id instead — a fresh one is minted
 * per attempt. Keep the tail when truncating: the trailing random suffix is
 * what's actually distinguishing, while the common timestamp-heavy prefix is
 * not.
 */
export function herdrAgentName(dispatchId: string): string {
  const suffix = dispatchId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `foreman-${suffix.slice(-(32 - "foreman-".length))}`;
}

let seqCounter = 0;

export class HerdrDispatcher implements Dispatcher {
  readonly kind = "herdr" as const;

  readonly #config: GlobalConfig;
  readonly #runner: HerdrRunner;
  readonly #scrubEnv: readonly string[];
  /** One pending `agent wait` per dispatch (keyed by its pane's agent name), so sibling handles of one dispatch share it rather than waiting N times. */
  readonly #pendingSettles = new Map<string, Promise<DispatchOutcome>>();

  constructor(
    config: GlobalConfig,
    options?: { runner?: HerdrRunner; scrubEnv?: string[] },
  ) {
    this.#config = config;
    this.#runner = options?.runner ?? nodeHerdrRunner;
    this.#scrubEnv = options?.scrubEnv ?? [];
  }

  /** Runs an herdr command and throws with its stderr when it exits non-zero. */
  async #runChecked(argv: string[]): Promise<{ stdout: string }> {
    const { stdout, stderr, code } = await this.#runner.run(argv);
    if (code !== 0) {
      throw new Error(`herdr ${argv.slice(1).join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    }
    return { stdout };
  }

  async available(): Promise<boolean> {
    try {
      const { code } = await this.#runner.run([this.#config.agent.herdrBin, "workspace", "list"]);
      return code === 0;
    } catch {
      return false;
    }
  }

  /** Herdr's own workspace list, matched by the worktree it was opened on — `null` when no workspace exists yet. */
  async #findWorkspaceId(repoPath: string): Promise<string | null> {
    // Maps save a little parsing within one process, but are insufficient for
    // a loop restarted around existing Herdr state. Re-read Herdr's own list
    // first so "one workspace per repo" holds across process lifetimes.
    const { stdout } = await this.#runChecked([this.#config.agent.herdrBin, "workspace", "list"]);
    const listed = JSON.parse(stdout) as HerdrWorkspaceListResult;
    return (
      listed.result.workspaces.find((workspace) => workspace.worktree?.checkout_path === repoPath)
        ?.workspace_id ?? null
    );
  }

  async #ensureWorkspace(repoPath: string): Promise<string> {
    const existing = await this.#findWorkspaceId(repoPath);
    if (existing) {
      return existing;
    }

    // `--cwd` (not `--label`) is what makes Herdr adopt the repo as this
    // workspace's worktree — the thing `#findWorkspaceId` matches on above.
    // A `--label` alone is a free-form display string Herdr never compares
    // against a path.
    const created = await this.#runChecked([
      this.#config.agent.herdrBin,
      "workspace",
      "create",
      "--cwd",
      repoPath,
      "--no-focus",
    ]);
    const parsed = JSON.parse(created.stdout) as { result: { workspace_id: string } };
    return parsed.result.workspace_id;
  }

  /** Herdr's own tab list within `workspaceId`, matched by label — `null` when no tab exists yet. */
  async #findTabId(workspaceId: string, label: string): Promise<string | null> {
    const { stdout } = await this.#runChecked([
      this.#config.agent.herdrBin,
      "tab",
      "list",
      "--workspace",
      workspaceId,
    ]);
    const listed = JSON.parse(stdout) as HerdrTabListResult;
    return listed.result.tabs.find((tab) => tab.label === label)?.tab_id ?? null;
  }

  /**
   * `pane split --pane` takes a pane id, never a tab id (SPEC §17.3 — verified
   * live against `herdr` 0.8.2, which returns `pane_not_found` for a tab id).
   * A tab's anchor is its oldest surviving pane; `pane list` doesn't flag
   * "root", so the first match in workspace order is that anchor.
   */
  async #findAnchorPaneId(workspaceId: string, tabId: string): Promise<string> {
    const { stdout } = await this.#runChecked([
      this.#config.agent.herdrBin,
      "pane",
      "list",
      "--workspace",
      workspaceId,
    ]);
    const listed = JSON.parse(stdout) as HerdrPaneListResult;
    const anchor = listed.result.panes.find((pane) => pane.tab_id === tabId);
    if (!anchor) {
      throw new Error(`herdr tab ${tabId} has no panes`);
    }
    return anchor.pane_id;
  }

  /** Shared by every `pane split` call — hands back either `result.pane` or `result.root_pane`. */
  #splitPaneId(stdout: string): string {
    const parsed = JSON.parse(stdout) as HerdrPaneResult;
    const paneId = parsed.result.pane?.pane_id ?? parsed.result.root_pane?.pane_id;
    if (!paneId) {
      throw new Error(`herdr pane split returned no pane id: ${stdout}`);
    }
    return paneId;
  }

  /**
   * A loop's tab (one per readonly stage or writing loop) — found across
   * process restarts by a stable label, the same way `#ensureWorkspace`
   * locates its workspace. Tabs outlive this dispatcher instance, so a
   * process restart must locate the prior tab rather than create a
   * duplicate for every resumed loop.
   */
  async #ensureLoopTab(workspaceId: string, loopName: string, cwd: string): Promise<string> {
    const existing = await this.#findTabId(workspaceId, loopName);
    if (existing) {
      return existing;
    }
    const created = await this.#runChecked([
      this.#config.agent.herdrBin,
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      loopName,
      "--no-focus",
    ]);
    const parsed = JSON.parse(created.stdout) as HerdrTabResult;
    return parsed.result.tab.tab_id;
  }

  /**
   * A fresh pane for one dispatch, split off the loop tab's anchor pane —
   * never a prior dispatch's pane, which may already be closed by the time
   * this one starts. Every dispatch to a loop gets its own pane, appended
   * downward in that loop's tab (SPEC §17.2).
   */
  async #newLoopPane(workspaceId: string, tabId: string, cwd: string, envArgs: string[]): Promise<string> {
    const anchor = await this.#findAnchorPaneId(workspaceId, tabId);
    const split = await this.#runChecked([
      this.#config.agent.herdrBin,
      "pane",
      "split",
      "--pane",
      anchor,
      "--direction",
      "down",
      "--cwd",
      cwd,
      ...envArgs,
    ]);
    return this.#splitPaneId(split.stdout);
  }

  /**
   * `worktree create`/`open` hand back a plain root pane with no way to
   * attach `--env` (verified live: neither subcommand accepts it), so it
   * never carries the scrubbed credentials or `FOREMAN_DISPATCH_ID` every
   * dispatch needs. Split a properly-enved pane off it and close the
   * original, leaving exactly one pane behind rather than two.
   */
  async #replacePane(anchorPaneId: string, cwd: string, envArgs: string[]): Promise<string> {
    const split = await this.#runChecked([
      this.#config.agent.herdrBin,
      "pane",
      "split",
      "--pane",
      anchorPaneId,
      "--direction",
      "down",
      "--cwd",
      cwd,
      ...envArgs,
    ]);
    const paneId = this.#splitPaneId(split.stdout);
    await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", anchorPaneId]);
    return paneId;
  }

  /**
   * A dispatch that writes code gets its own workspace bound to a real git
   * worktree (SPEC §12) — Herdr's own `worktree` family shells `git worktree
   * add`/`remove` for us, so this is the only place a writing dispatch
   * touches git, mirroring how `#ensureWorkspace` owns the repo workspace.
   */
  async #ensureWorktreeWorkspace(
    mainWorkspaceId: string,
    worktree: { path: string; branch: string; baseBranch: string },
    label: string,
    envArgs: string[],
  ): Promise<string> {
    const { stdout } = await this.#runChecked([this.#config.agent.herdrBin, "workspace", "list"]);
    const listed = JSON.parse(stdout) as HerdrWorkspaceListResult;
    const existing = listed.result.workspaces.find(
      (workspace) => workspace.worktree?.checkout_path === worktree.path,
    );
    if (existing) {
      // Same story as a reused loop tab: the workspace's own pane already
      // hosts a prior agent at its idle prompt, not a plain shell.
      const anchor = await this.#findAnchorPaneId(existing.workspace_id, existing.active_tab_id);
      // `#replacePane` closes the anchor. A workspace whose pane still hosts a
      // working agent is a live implement session, not a finished one at an
      // idle prompt — refuse rather than kill it.
      const { stdout, code } = await this.#runner.run([this.#config.agent.herdrBin, "pane", "get", anchor]);
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout) as HerdrPaneGetResult;
          const status = parsed.result.pane?.agent_status;
          if (status === "working" || status === "blocked") {
            throw new DispatcherBusyError(`worktree pane ${anchor} still hosts a ${status} agent`);
          }
        } catch (error) {
          if (error instanceof DispatcherBusyError) throw error;
          // Unparsable pane payload: fall through and reuse.
        }
      }
      return this.#replacePane(anchor, worktree.path, envArgs);
    }

    const created = await this.#runner.run([
      this.#config.agent.herdrBin,
      "worktree",
      "create",
      "--workspace",
      mainWorkspaceId,
      "--branch",
      worktree.branch,
      "--base",
      worktree.baseBranch,
      "--path",
      worktree.path,
      "--label",
      label,
      "--no-focus",
    ]);
    if (created.code === 0) {
      const parsed = JSON.parse(created.stdout) as HerdrWorktreeResult;
      return this.#replacePane(parsed.result.root_pane.pane_id, worktree.path, envArgs);
    }

    // The git worktree already exists on disk with no live workspace open on
    // it (e.g. a prior process's workspace was closed without removing it,
    // verified live: `worktree create` fails `worktree_create_failed` there)
    // — adopt it with `worktree open` instead of failing the dispatch.
    let errorCode: string | undefined;
    try {
      const parsedError = JSON.parse(created.stderr) as HerdrErrorResponse;
      errorCode = parsedError.error?.code;
    } catch {
      // Unparsable stderr — fall through and surface the original failure.
    }
    if (errorCode !== "worktree_create_failed") {
      throw new Error(`herdr worktree create failed (exit ${created.code}): ${created.stderr.trim()}`);
    }
    const opened = await this.#runChecked([
      this.#config.agent.herdrBin,
      "worktree",
      "open",
      "--workspace",
      mainWorkspaceId,
      "--path",
      worktree.path,
      "--label",
      label,
      "--no-focus",
    ]);
    const parsedOpen = JSON.parse(opened.stdout) as HerdrWorktreeResult;
    return this.#replacePane(parsedOpen.result.root_pane.pane_id, worktree.path, envArgs);
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const worktreeItems = request.items.filter((item) => item.worktree);
    if (worktreeItems.length > 0 && request.items.length > 1) {
      throw new Error("herdr dispatch cannot mix a worktree item with other items in one request");
    }

    const workspaceId = await this.#ensureWorkspace(request.cwd);

    const envArgs: string[] = [];
    for (const name of this.#scrubEnv) {
      envArgs.push("--env", `${name}=`);
    }

    // A single-item request (the per-issue implement path, an operator
    // dispatch, or a lone readonly item) gets its dispatch id in the
    // environment. A multi-item batch (e.g. triage) shares one pane and one
    // prompt across every item, so no single id belongs there.
    if (request.items.length === 1) {
      envArgs.push("--env", `FOREMAN_DISPATCH_ID=${request.items[0]!.dispatchId}`);
    }

    let paneId: string;
    if (worktreeItems.length === 1) {
      const item = request.items[0]!;
      paneId = await this.#ensureWorktreeWorkspace(
        workspaceId,
        item.worktree!,
        item.issueId ?? item.dispatchId,
        envArgs,
      );
    } else {
      const loopName = `${request.alias}-${request.agent.replace(/^foreman-/, "")}`;
      const tabId = await this.#ensureLoopTab(workspaceId, loopName, request.cwd);
      paneId = await this.#newLoopPane(workspaceId, tabId, request.cwd, envArgs);
    }

    const agentName = herdrAgentName(request.items[0]!.dispatchId);
    const promptText = [
      request.command,
      ...request.items.map((item) => item.subject).filter((subject): subject is string => subject !== null),
    ].join(" ");
    try {
      // `agent start` only recognizes an agent that reaches Herdr's own
      // interactive-readiness state; omp's `-p`/`--print` mode processes a
      // prompt and exits immediately, which Herdr never observes as
      // "ready for input" (SPEC §17.2). Start omp interactively — no
      // prompt, no `-p` — then hand it the actual command through
      // `agent prompt` once Herdr confirms it is idle.
      await this.#runChecked([
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
        "--approval-mode",
        this.#config.agent.approvalMode,
        "--cwd",
        request.cwd,
      ]);
      await this.#runChecked([
        this.#config.agent.herdrBin,
        "agent",
        "prompt",
        agentName,
        promptText,
        "--wait",
        "--until",
        "working",
        "--until",
        "done",
        "--timeout",
        "30000",
      ]);
    } catch (error) {
      await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", paneId]);
      throw error;
    }

    seqCounter += 1;
    const issueToken =
      request.items
        .map((item) => item.issueId)
        .filter((issueId): issueId is string => issueId !== null)
        .join(",") || BATCH_SUBJECT;
    await this.#runChecked([
      this.#config.agent.herdrBin,
      "pane",
      "report-metadata",
      paneId,
      "--source",
      "foreman",
      "--token",
      `issue=${issueToken}`,
      "--token",
      `agent=${request.agent}`,
      "--seq",
      String(seqCounter),
      "--ttl-ms",
      String(this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs),
    ]);

    const startedAt = new Date().toISOString();
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt,
      pid: null,
      herdr: { paneId, agentName },
    }));
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
      const parsed = JSON.parse(stdout) as HerdrAgentResult;
      // Herdr's classification is a UI signal only (SPEC §17.3) — mapped here
      // to the Dispatcher's coarse starting/running/settled/lost vocabulary,
      // never fed back into a routing decision.
      switch (parsed.result.agent.agent_status) {
        case "idle":
        case "done":
          return "settled";
        case "working":
        case "blocked":
          return "running";
        default:
          return "lost";
      }
    } catch {
      return "lost";
    }
  }

  /** The actual `agent wait` for one dispatch — shared by every sibling handle in it via `#pendingSettles`. */
  async #waitForDispatch(handle: DispatchHandle): Promise<DispatchOutcome> {
    if (!handle.herdr) {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
    const timeoutMs = this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs;
    try {
      // An interactive omp session never exits when its turn ends — it goes
      // to `idle` — so `--until done` alone would never match a live agent;
      // `idle` is the normal "turn finished" signal for it.
      const { code } = await this.#runner.run([
        this.#config.agent.herdrBin,
        "agent",
        "wait",
        handle.herdr.agentName,
        "--until",
        "idle",
        "--until",
        "done",
        "--timeout",
        String(timeoutMs),
      ]);
      if (handle.agent !== "foreman-implement") {
        // Every dispatch now gets its own pane, so nothing is lost closing
        // it once settled. A writing dispatch's worktree pane stays open
        // instead — the operator may still need to attach and inspect the
        // code it wrote — and is closed later by post-merge `cleanup()`.
        await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", handle.herdr.paneId]);
      }
      return { handle, status: code === 0 ? "settled" : "lost", exitCode: code, log: "" };
    } catch {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
  }

  /**
   * Herdr is not the results channel (SPEC §17.3): the loop reads Linear, not
   * panes. `settle` exists to satisfy the interface uniformly with
   * `PrintDispatcher`; it waits for the dispatch's agent to leave `working`
   * and returns an empty log, never scraping pane content. Every sibling
   * handle from the same `dispatch()` call shares one `agent wait` — they
   * carry the same pane and agent name — rather than starting N.
   */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    if (!handle.herdr) {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
    const key = handle.herdr.agentName;
    let pending = this.#pendingSettles.get(key);
    if (!pending) {
      pending = this.#waitForDispatch(handle).finally(() => {
        this.#pendingSettles.delete(key);
      });
      this.#pendingSettles.set(key, pending);
    }
    const outcome = await pending;
    return { ...outcome, handle };
  }

  /**
   * Post-merge housekeeping (SPEC §12): closes the issue's worktree
   * workspace, if it had one. A readonly dispatch's pane is already closed
   * by `settle()`, so there is nothing else to close here. A no-op when the
   * issue had no worktree or its workspace is already gone.
   */
  async cleanup(issueId: string, repoPath: string, worktreePath: string | null): Promise<void> {
    if (!worktreePath) return;
    const workspaceId = await this.#findWorkspaceId(worktreePath);
    if (!workspaceId) return;
    await this.#runChecked([this.#config.agent.herdrBin, "workspace", "close", workspaceId]);
  }
}
