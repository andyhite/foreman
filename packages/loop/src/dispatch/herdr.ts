/**
 * `HerdrDispatcher` (SPEC §17.2, §17.3, §17.4).
 *
 * A real terminal pane per agent, live state, and the ability to attach and
 * take over. Layout: one workspace per repo (the instance and its bound
 * initiatives from the registry, §3.11), one tab per readonly stage
 * (triage/plan/refine/review) named for the stage and held open across
 * batches by that stage's shared orchestrator, one pane per writing dispatch
 * with `--cwd` set to the issue's worktree, and a `foreman` workspace holding
 * the board and `foreman team` panes — each repo workspace holds its own
 * `foreman repo` pane.
 *
 * Everything herdr returns is read from its own JSON output — ids are never
 * predicted, because `pane move` changes a pane's qualified id and only the
 * returned JSON carries the new one.
 *
 * Agent state (`working`/`idle`/`blocked`/…) is never read here as a routing
 * input (SPEC §17.3) — this class only starts and locates panes/tabs/agents,
 * and uses that state solely to decide whether a shared orchestrator's pane
 * can be reused or must be recycled. `nextAction` decisions come from Linear
 * alone, in `packages/loop`.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
  ForemanAgentName,
  GlobalConfig,
} from "@foreman/core";
import { BATCH_SUBJECT, RESERVATIONS_ENV, reservationsPath } from "@foreman/core";
import { OrchestratorBusyError } from "./busy.ts";

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
interface HerdrMoveResult {
  result: { move_result: { pane: { pane_id: string }; previous_pane_id: string } };
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
 * which for an issue-scoped dispatch doesn't happen until post-merge
 * `cleanup()`. Keying this off `issueId` would collide on every redispatch to
 * the same issue before merge, so it always takes the dispatch id instead —
 * a fresh one is minted per attempt. Keep the tail when truncating: the
 * trailing random suffix is what's actually distinguishing, while the common
 * timestamp-heavy prefix is not.
 */
export function herdrAgentName(dispatchId: string): string {
  const suffix = dispatchId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `foreman-${suffix.slice(-(32 - "foreman-".length))}`;
}

/**
 * The shared per-stage orchestrator's name (SPEC §17.4). Two loops on one
 * machine (two repo aliases, or a repo alongside the `intake` loop) must not
 * derive the same name for their refine orchestrators, so the alias is
 * folded in — and truncated, not the stage suffix, because the stage is what
 * a human scanning `herdr agent list` needs intact to tell triage from
 * refine from review.
 */
export function sharedAgentName(alias: string, agent: ForemanAgentName): string {
  const stage = agent.replace(/^foreman-/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const normalizedAlias = alias.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const prefix = "foreman-";
  const suffix = `-${stage}`;
  const aliasBudget = Math.max(1, 32 - prefix.length - suffix.length);
  return `${prefix}${normalizedAlias.slice(0, aliasBudget)}${suffix}`;
}

let seqCounter = 0;

export class HerdrDispatcher implements Dispatcher {
  readonly kind = "herdr" as const;

  readonly #config: GlobalConfig;
  readonly #runner: HerdrRunner;
  readonly #scrubEnv: readonly string[];
  readonly #reservationsDir: string | undefined;
  /**
   * `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` — injected by herdr
   * into every pane it manages — locate *this process's own* pane when it
   * is itself running inside herdr. `agent.herdrLayout: "pane"` anchors its
   * column there; defaults to `process.env` and is overridable so tests
   * don't depend on the real process environment.
   */
  readonly #env: NodeJS.ProcessEnv;
  /** One pending `agent wait` per batch, so sibling handles share it rather than waiting N times. */
  readonly #pendingSettles = new Map<string, Promise<DispatchOutcome>>();
  /** Settled batches served by each shared orchestrator, since its last (re)start — SPEC §17.4 recycling. */
  readonly #batchCounts = new Map<string, number>();

  constructor(
    config: GlobalConfig,
    options?: { runner?: HerdrRunner; scrubEnv?: string[]; reservationsDir?: string; env?: NodeJS.ProcessEnv },
  ) {
    this.#config = config;
    this.#runner = options?.runner ?? nodeHerdrRunner;
    this.#scrubEnv = options?.scrubEnv ?? [];
    this.#reservationsDir = options?.reservationsDir;
    this.#env = options?.env ?? process.env;
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
    const { stdout } = await this.#runChecked([
      this.#config.agent.herdrBin,
      "workspace",
      "list",
    ]);
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
    const workspaceId = parsed.result.workspace_id;
    return workspaceId;
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

  async #ensureTab(
    workspaceId: string,
    label: string,
    cwd: string,
    envArgs: string[],
  ): Promise<{ tabId: string; paneId: string }> {
    // Like workspaces, tabs outlive this dispatcher instance. A process restart
    // must locate the prior tab by its stable stage label rather than create a
    // duplicate for every resumed dispatch.
    const existing = await this.#findTabId(workspaceId, label);
    if (existing) {
      // A reused tab's anchor pane already hosts a prior agent at its own
      // idle prompt, not a plain shell — herdr refuses `agent start` there
      // (`agent_pane_busy`, verified live). Split off a fresh shell instead
      // of touching it.
      const anchor = await this.#findAnchorPaneId(workspaceId, existing);
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
      const paneId = this.#splitPaneId(split.stdout);
      return { tabId: existing, paneId };
    }

    // A freshly created tab's root pane is already a plain shell at `cwd` —
    // splitting it would only abandon that pane forever, doubling every
    // single-shot issue's pane count for nothing (verified live: the root
    // pane accepts `agent start` directly, no split needed).
    const created = await this.#runChecked([
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
      ...envArgs,
    ]);
    const parsed = JSON.parse(created.stdout) as HerdrTabResult;
    return { tabId: parsed.result.tab.tab_id, paneId: parsed.result.root_pane.pane_id };
  }

  /**
   * The herdr pane/tab/workspace hosting *this* process, when it is itself
   * running inside a managed pane — `null` when it isn't (e.g. a
   * cron/launchd-run loop, SPEC §3.12), which is the signal
   * `#ensureStagePane` uses to fall back to the tab strategy.
   */
  #callerPaneContext(): { workspaceId: string; tabId: string; paneId: string } | null {
    const workspaceId = this.#env.HERDR_WORKSPACE_ID;
    const tabId = this.#env.HERDR_TAB_ID;
    const paneId = this.#env.HERDR_PANE_ID;
    if (!workspaceId || !tabId || !paneId) return null;
    return { workspaceId, tabId, paneId };
  }

  /** Shared by `#ensureTab`'s split call and `#ensurePaneColumn`'s — both hand back either `result.pane` or `result.root_pane`. */
  #splitPaneId(stdout: string): string {
    const parsed = JSON.parse(stdout) as HerdrPaneResult;
    const paneId = parsed.result.pane?.pane_id ?? parsed.result.root_pane?.pane_id;
    if (!paneId) {
      throw new Error(`herdr pane split returned no pane id: ${stdout}`);
    }
    return paneId;
  }

  /**
   * `agent.herdrLayout: "pane"`'s pane for a stage's shared orchestrator: a
   * right-hand column split off the caller's own pane in its current tab,
   * further split downward into one row per stage — instead of `#ensureTab`'s
   * one tab per stage. Rows are found across process restarts by a
   * `foreman-<stage>` pane label, the pane-scoped equivalent of `#ensureTab`'s
   * tab label.
   *
   * The column only spans the whole tab's height when the caller's pane was
   * the tab's sole occupant at the moment the first row split off it — herdr's
   * pane tree has no operation to retroactively wrap panes that already sit
   * beside it (`docs/VERIFIED.md`). Once created, later splits on either side
   * (the operator's own panes, or more stage rows) never shrink the column,
   * because each split only ever divides its own pane.
   */
  async #ensurePaneColumn(
    caller: { workspaceId: string; tabId: string; paneId: string },
    label: string,
    cwd: string,
    envArgs: string[],
  ): Promise<{ tabId: string; paneId: string }> {
    const paneLabel = `foreman-${label}`;
    const { stdout } = await this.#runChecked([this.#config.agent.herdrBin, "pane", "list", "--workspace", caller.workspaceId]);
    const listed = JSON.parse(stdout) as HerdrPaneListResult;
    const tabPanes = listed.result.panes.filter((pane) => pane.tab_id === caller.tabId);

    const existingRow = tabPanes.find((pane) => pane.label === paneLabel);
    if (existingRow) {
      // Same story as a reused tab in `#ensureTab`: the row already hosts a
      // prior agent at its own idle prompt, not a plain shell.
      const split = await this.#runChecked([
        this.#config.agent.herdrBin,
        "pane",
        "split",
        "--pane",
        existingRow.pane_id,
        "--direction",
        "down",
        "--cwd",
        cwd,
        ...envArgs,
      ]);
      const paneId = this.#splitPaneId(split.stdout);
      await this.#runChecked([this.#config.agent.herdrBin, "pane", "rename", paneId, paneLabel]);
      return { tabId: caller.tabId, paneId };
    }

    // Another stage's row already anchors the column — stack this stage
    // below it rather than opening a second column. Otherwise this is the
    // column's first row: split the caller's own pane to the right.
    const anyColumnPane = tabPanes.find((pane) => (pane.label ?? "").startsWith("foreman-"));
    const splitFrom = anyColumnPane?.pane_id ?? caller.paneId;
    const direction = anyColumnPane ? "down" : "right";
    const split = await this.#runChecked([
      this.#config.agent.herdrBin,
      "pane",
      "split",
      "--pane",
      splitFrom,
      "--direction",
      direction,
      "--cwd",
      cwd,
      ...envArgs,
    ]);
    const paneId = this.#splitPaneId(split.stdout);
    await this.#runChecked([this.#config.agent.herdrBin, "pane", "rename", paneId, paneLabel]);
    return { tabId: caller.tabId, paneId };
  }

  /** Routes a stage's shared orchestrator to `#ensureTab` or `#ensurePaneColumn` per `agent.herdrLayout`. */
  async #ensureStagePane(
    workspaceId: string,
    label: string,
    cwd: string,
    envArgs: string[],
  ): Promise<{ tabId: string; paneId: string }> {
    if (this.#config.agent.herdrLayout === "pane") {
      const caller = this.#callerPaneContext();
      if (caller) {
        return this.#ensurePaneColumn(caller, label, cwd, envArgs);
      }
    }
    return this.#ensureTab(workspaceId, label, cwd, envArgs);
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
      // Same story as a reused tab: the workspace's own pane already hosts a
      // prior agent at its idle prompt, not a plain shell.
      const anchor = await this.#findAnchorPaneId(existing.workspace_id, existing.active_tab_id);
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

  /**
   * Locates or starts a stage's shared orchestrator (SPEC §17.4). herdr state
   * decides only whether the existing pane can be reused — never a routing
   * input, per the class doc — so a stale `unknown` agent is discarded rather
   * than trusted, and `working`/`blocked` refuse the dispatch outright
   * instead of silently queuing behind an in-flight turn.
   */
  async #resolveSharedAgentPane(
    workspaceId: string,
    request: DispatchRequest,
    agentName: string,
    envArgs: string[],
  ): Promise<{ paneId: string; startedFresh: boolean }> {
    const { stdout, code } = await this.#runner.run([this.#config.agent.herdrBin, "agent", "get", agentName]);
    let status: string | undefined;
    let existingPaneId: string | undefined;
    if (code === 0) {
      try {
        const parsed = JSON.parse(stdout) as HerdrAgentResult;
        status = parsed.result.agent.agent_status;
        existingPaneId = parsed.result.agent.pane_id;
      } catch {
        status = undefined;
      }
    }

    if (status === "idle" || status === "done") {
      if (!existingPaneId) {
        throw new Error(`herdr agent get ${agentName} returned no pane id`);
      }
      return { paneId: existingPaneId, startedFresh: false };
    }
    if (status === "working") {
      throw new OrchestratorBusyError(agentName, `shared orchestrator ${agentName} is mid-turn`);
    }
    if (status === "blocked") {
      // SPEC §17.3: a herdr `blocked` agent is a Foreman bug, never a routine
      // busy signal — surface it as a plain error rather than a skip.
      throw new Error(`herdr agent ${agentName} is blocked`);
    }

    // `unknown` or absent (no such agent yet): discard any stale pane and
    // start a fresh shared orchestrator.
    if (existingPaneId) {
      await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", existingPaneId]);
    }
    const stageLabel = request.agent.replace(/^foreman-/, "");
    const { paneId } = await this.#ensureStagePane(workspaceId, stageLabel, request.cwd, envArgs);
    return { paneId, startedFresh: true };
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
    if (this.#reservationsDir) {
      envArgs.push("--env", `${RESERVATIONS_ENV}=${reservationsPath(this.#reservationsDir, request.agent)}`);
    }
    // A shared orchestrator serves many items across many turns, so it can
    // never carry one item's id in its environment — the loop hands it
    // reservations instead (SPEC §17.4). Only a single-item request (the
    // per-issue implement path, or an operator dispatch) gets one.
    if (request.items.length === 1) {
      envArgs.push("--env", `FOREMAN_DISPATCH_ID=${request.items[0]!.dispatchId}`);
    }

    // A dispatch that writes code gets its own worktree-backed workspace and
    // its own per-attempt agent (SPEC §12); every readonly stage
    // (triage/plan/refine/review) instead reuses one shared orchestrator per
    // stage, prompted with every item's subject in one turn (SPEC §17.4).
    if (worktreeItems.length === 1) {
      const item = request.items[0]!;
      const paneId = await this.#ensureWorktreeWorkspace(
        workspaceId,
        item.worktree!,
        item.issueId ?? item.dispatchId,
        envArgs,
      );
      const agentName = herdrAgentName(item.dispatchId);
      const promptText = item.subject ? `${request.command} ${item.subject}` : request.command;
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
      await this.#runChecked([
        this.#config.agent.herdrBin,
        "pane",
        "report-metadata",
        paneId,
        "--source",
        "foreman",
        "--token",
        `issue=${item.issueId ?? BATCH_SUBJECT}`,
        "--token",
        `agent=${request.agent}`,
        "--seq",
        String(seqCounter),
        "--ttl-ms",
        String(this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs),
      ]);

      const batchId = randomUUID().slice(0, 8);
      return [
        {
          dispatchId: item.dispatchId,
          agent: request.agent,
          issueId: item.issueId,
          startedAt: new Date().toISOString(),
          batchId,
          pid: null,
          herdr: { paneId, agentName },
        },
      ];
    }

    const agentName = sharedAgentName(request.alias, request.agent);
    const { paneId, startedFresh } = await this.#resolveSharedAgentPane(
      workspaceId,
      request,
      agentName,
      envArgs,
    );
    const promptText = [
      request.command,
      ...request.items.map((item) => item.subject).filter((subject): subject is string => subject !== null),
    ].join(" ");
    try {
      if (startedFresh) {
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
      }
      await this.#runChecked([
        this.#config.agent.herdrBin,
        "agent",
        "prompt",
        agentName,
        promptText,
        "--wait",
        "--until",
        "working",
        "--timeout",
        "30000",
      ]);
    } catch (error) {
      // A reused orchestrator's pane already hosted a live session before
      // this call — closing it on failure would kill work this dispatch
      // never started. Only a freshly created pane is this call's to undo.
      if (startedFresh) {
        await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", paneId]);
      }
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

    const batchId = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();
    return request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt,
      batchId,
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

  /** The actual `agent wait` for one batch — shared by every handle in it via `#pendingSettles`. */
  async #waitForBatch(handle: DispatchHandle): Promise<DispatchOutcome> {
    if (!handle.herdr) {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
    const timeoutMs = this.#config.agent.maxRuntimeMs + this.#config.agent.lockTtlMarginMs;
    try {
      // An interactive omp session never exits when its turn ends — it goes
      // to `idle` — so `--until done` alone would never match a live shared
      // orchestrator; `idle` is the normal "turn finished" signal for it.
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
      if (handle.agent === "foreman-implement") {
        // A writing dispatch's worktree pane stays open until post-merge
        // `cleanup()` — the operator may still need to attach and inspect
        // the code it wrote.
        return { handle, status: code === 0 ? "settled" : "lost", exitCode: code, log: "" };
      }

      // A shared orchestrator carries no state between batches, so nothing
      // is lost recycling it — this only bounds context growth (SPEC §17.4).
      const servedBatches = (this.#batchCounts.get(handle.herdr.agentName) ?? 0) + 1;
      if (servedBatches >= this.#config.agent.orchestratorMaxBatches) {
        await this.#runner.run([this.#config.agent.herdrBin, "pane", "close", handle.herdr.paneId]);
        this.#batchCounts.delete(handle.herdr.agentName);
      } else {
        this.#batchCounts.set(handle.herdr.agentName, servedBatches);
      }
      return { handle, status: code === 0 ? "settled" : "lost", exitCode: code, log: "" };
    } catch {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
  }

  /**
   * Herdr is not the results channel (SPEC §17.3): the loop reads Linear, not
   * panes. `settle` exists to satisfy the interface uniformly with
   * `PrintDispatcher`; it waits for the batch's agent to leave `working` and
   * returns an empty log, never scraping pane content. Every handle sharing a
   * `batchId` shares one `agent wait` rather than starting N.
   */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    if (!handle.herdr) {
      return { handle, status: "lost", exitCode: null, log: "" };
    }
    let pending = this.#pendingSettles.get(handle.batchId);
    if (!pending) {
      pending = this.#waitForBatch(handle).finally(() => {
        this.#pendingSettles.delete(handle.batchId);
      });
      this.#pendingSettles.set(handle.batchId, pending);
    }
    const outcome = await pending;
    return { ...outcome, handle };
  }

  async attach(handle: DispatchHandle): Promise<void> {
    if (!handle.herdr) return;
    await this.#runner.run([this.#config.agent.herdrBin, "agent", "focus", handle.herdr.agentName]);
  }

  /**
   * Post-merge housekeeping (SPEC §12): closes the issue's worktree
   * workspace, if it had one. Readonly dispatches never get a per-issue
   * pane — they share a stage's orchestrator, which `settle()` recycles on
   * its own batch-count schedule — so there is nothing else to close here. A
   * no-op when the issue had no worktree or its workspace is already gone.
   */
  async cleanup(issueId: string, repoPath: string, worktreePath: string | null): Promise<void> {
    if (!worktreePath) return;
    const workspaceId = await this.#findWorkspaceId(worktreePath);
    if (!workspaceId) return;
    await this.#runChecked([this.#config.agent.herdrBin, "workspace", "close", workspaceId]);
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
