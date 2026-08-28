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
 * Whether an existing agent named `foreman-loop` is still live — checked via
 * `herdr agent get`, since a stopped process leaves no live agent even if the
 * guard pane record still points at a pane. Absence of a live agent, not
 * absence of the pane, is what should trigger a re-launch.
 *
 * UNVERIFIED: exit-code-as-liveness (0 = live, nonzero = not found/dead) is
 * inferred, not confirmed against `herdr agent get --help` or real output.
 * Keep this defensive rather than parsing a specific error shape if it turns
 * out to be wrong.
 */
async function loopAgentIsLive(herdrBin: string): Promise<boolean> {
  const { exitCode } = await defaultRunCommand(herdrBin, ["agent", "get", LOOP_PANE_LABEL]);
  return exitCode === 0;
}

/**
 * Idempotent startup: ensures workspace `foreman`, a tab, a shell pane, and a
 * `foreman-loop` agent running inside it, then persists the ids to the guard
 * file so a re-run on live handoff can verify liveness instead of blindly
 * recreating the layout (SPEC §17.4).
 */
export async function runStartup(env: Record<string, string | undefined> = process.env): Promise<void> {
  const herdrBin = env.HERDR_BIN_PATH ?? "herdr";
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set; cannot guard against double-start.");

  const existing = readGuard(stateDir);
  if (existing && (await loopAgentIsLive(herdrBin))) {
    return;
  }

  const workspace = await runHerdrJson<{ workspace: { workspace_id: string } }>(herdrBin, [
    "workspace",
    "create",
    "--label",
    WORKSPACE_LABEL,
    "--no-focus",
  ]);
  const workspaceId = workspace.result?.workspace?.workspace_id ?? existing?.workspaceId;
  if (!workspaceId) throw new Error(`Failed to create the ${WORKSPACE_LABEL} workspace: ${workspace.stderr}`);

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

  const agentStart = await defaultRunCommand(herdrBin, [
    "agent",
    "start",
    LOOP_PANE_LABEL,
    "--kind",
    "omp",
    "--pane",
    paneId,
    "--timeout",
    "30000",
    "--",
    "foreman-loop",
    "start",
  ]);
  if (agentStart.exitCode !== 0) {
    throw new Error(`Failed to start the ${LOOP_PANE_LABEL} agent: ${agentStart.stderr}`);
  }

  writeGuard(stateDir, { workspaceId, tabId, paneId, createdAt: new Date().toISOString() });
}

if (import.meta.main) {
  await runStartup();
}
