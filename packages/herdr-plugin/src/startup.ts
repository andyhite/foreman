#!/usr/bin/env bun
/**
 * `[[startup]]` hook (SPEC §17.4): ensures a long-lived `foreman-loop` pane
 * exists in a `foreman` workspace. Startup hooks are one-shot initialization,
 * not a supervised service — this creates the workspace/tab/pane once and
 * exits; what runs inside the pane (`foreman-loop`, §17.5) is a normal
 * long-running process the pane host keeps alive.
 *
 * Two invariants this file exists to protect:
 * - **The loop must not live in the board's pane.** Closing the board must
 *   never stop the loop, so this creates a pane dedicated to
 *   `foreman-loop start` and never reuses a board pane.
 * - **Startup hooks re-run on live handoff.** A guard file in
 *   `HERDR_PLUGIN_STATE_DIR` prevents a second `foreman-loop` pane (and a
 *   second supervisor racing the first, SPEC §17.4 "the loop is a singleton")
 *   from being created on every server restore.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRunCommand } from "./actions.ts";

const WORKSPACE_LABEL = "foreman";
const LOOP_PANE_LABEL = "foreman-loop";

interface GuardState {
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdAt: string;
}

function guardPath(stateDir: string): string {
  return join(stateDir, "loop-pane.json");
}

/**
 * Reads the guard file. A missing or unparseable file means "no pane has
 * been created yet" rather than an error — the common case on first install.
 */
function readGuard(stateDir: string): GuardState | null {
  const path = guardPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.workspaceId === "string" &&
      typeof parsed.tabId === "string" &&
      typeof parsed.paneId === "string"
    ) {
      return { workspaceId: parsed.workspaceId, tabId: parsed.tabId, paneId: parsed.paneId, createdAt: String(parsed.createdAt ?? "") };
    }
    return null;
  } catch {
    return null;
  }
}

function writeGuard(stateDir: string, guard: GuardState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(guardPath(stateDir), JSON.stringify(guard, null, 2));
}

interface HerdrJsonResult<T> {
  ok: boolean;
  result: T | null;
  stderr: string;
}

async function runHerdrJson<T>(herdrBin: string, args: string[]): Promise<HerdrJsonResult<T>> {
  const { exitCode, stdout, stderr } = await defaultRunCommand(herdrBin, args);
  if (exitCode !== 0) return { ok: false, result: null, stderr };
  try {
    const parsed = JSON.parse(stdout) as { result?: T };
    return { ok: true, result: parsed.result ?? null, stderr: "" };
  } catch {
    return { ok: false, result: null, stderr: `unparseable JSON from herdr ${args.join(" ")}` };
  }
}

/**
 * Whether the guarded pane still exists. `pane get` exits 0 for a live pane
 * and non-zero once it is closed, which is the signal that matters here: the
 * hook's contract is "a long-lived loop pane exists", and a pane whose loop
 * has exited still holds the operator's scrollback about why.
 *
 * Deliberately not `agent get`: the loop is an ordinary process, not a coding
 * agent, so herdr never registers it under an agent name (see below).
 */
async function loopPaneIsLive(herdrBin: string, paneId: string): Promise<boolean> {
  const { exitCode } = await defaultRunCommand(herdrBin, ["pane", "get", paneId]);
  return exitCode === 0;
}

/**
 * Absolute path to the built loop entrypoint, which lives in a sibling package.
 * Resolved from the plugin root rather than PATH: `foreman-loop` is a workspace
 * bin and is not installed globally.
 */
function resolveLoopEntry(pluginRoot: string): string {
  const entry = join(pluginRoot, "..", "loop", "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(
      `The loop is not built at ${entry}. Run \`bun run build\` in the Foreman repo, ` +
        `then restart herdr or invoke the startup hook again.`,
    );
  }
  return entry;
}

/**
 * Idempotent startup: ensures workspace `foreman`, a tab, and the loop running
 * as an ordinary process in that tab's pane, then persists the ids so a re-run
 * on live handoff verifies liveness instead of rebuilding the layout (SPEC §17.4).
 */
export async function runStartup(env: Record<string, string | undefined> = process.env): Promise<void> {
  const herdrBin = env.HERDR_BIN_PATH ?? "herdr";
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set; cannot guard against double-start.");
  const pluginRoot = env.HERDR_PLUGIN_ROOT;
  if (!pluginRoot) throw new Error("HERDR_PLUGIN_ROOT is not set; cannot locate the loop entrypoint.");

  const loopEntry = resolveLoopEntry(pluginRoot);

  const existing = readGuard(stateDir);
  if (existing && (await loopPaneIsLive(herdrBin, existing.paneId))) {
    return;
  }

  /*
   * Reuse an existing `foreman` workspace before creating one. `workspace
   * create` always creates, so an unconditional call produces a duplicate every
   * time the guard file is absent — measured against herdr 0.8.2, three
   * workspaces all labelled `foreman` after three startup runs. The operator's
   * own workspace for this repo is almost always already there.
   */
  const listed = await runHerdrJson<{ workspaces: Array<{ workspace_id: string; label?: string }> }>(
    herdrBin,
    ["workspace", "list"],
  );
  const reusable = listed.result?.workspaces?.find((w) => w.label === WORKSPACE_LABEL);

  let workspaceId = reusable?.workspace_id ?? existing?.workspaceId ?? null;
  if (!workspaceId) {
    const created = await runHerdrJson<{ workspace: { workspace_id: string } }>(herdrBin, [
      "workspace",
      "create",
      "--label",
      WORKSPACE_LABEL,
      "--no-focus",
    ]);
    workspaceId = created.result?.workspace?.workspace_id ?? null;
    if (!workspaceId) {
      throw new Error(`Failed to create the ${WORKSPACE_LABEL} workspace: ${created.stderr}`);
    }
  }

  const tab = await runHerdrJson<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(herdrBin, [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    LOOP_PANE_LABEL,
    "--no-focus",
  ]);
  const tabId = tab.result?.tab?.tab_id;
  const paneId = tab.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error(`Failed to create the ${LOOP_PANE_LABEL} tab: ${tab.stderr}`);

  /*
   * `pane run`, not `agent start`. The loop is a supervisor process, and
   * `agent start --kind omp` launches an *interactive omp session* in the pane
   * and waits for herdr to recognize it as a coding agent. Measured against
   * herdr 0.8.2, that is exactly what happens: the pane came up as an omp agent
   * sitting at a question prompt, herdr reported `agent_not_ready`, and the loop
   * never ran. Agent commands are for things herdr must classify as agents;
   * ordinary processes belong to the pane surface.
   */
  const launch = await defaultRunCommand(herdrBin, [
    "pane",
    "run",
    paneId,
    `exec bun run ${JSON.stringify(loopEntry)}`,
  ]);
  if (launch.exitCode !== 0) {
    throw new Error(`Failed to start the loop in pane ${paneId}: ${launch.stderr}`);
  }

  writeGuard(stateDir, { workspaceId, tabId, paneId, createdAt: new Date().toISOString() });
}

if (import.meta.main) {
  await runStartup();
}
