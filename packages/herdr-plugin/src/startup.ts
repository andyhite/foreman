#!/usr/bin/env bun
/**
 * `[[startup]]` hook (SPEC §17.4): ensures one `foreman-loop` pane per
 * registry repo (SPEC §3.11, §17.3 — the loop is a per-repo singleton, one
 * workspace per repo) plus a shared `foreman intake` pane in the `foreman`
 * workspace (SPEC §3.12, §17.3 — the `foreman` workspace holds the board and
 * the intake pane). Startup hooks are one-shot initialization, not a
 * supervised service — this creates each workspace/tab/pane once and exits;
 * what runs inside them (`foreman loop`, `foreman intake`) is a normal
 * long-running process the pane host keeps alive.
 *
 * Two invariants this file exists to protect:
 * - **A loop must not live in the board's pane.** Closing the board must
 *   never stop a loop, so each repo gets a pane dedicated to `foreman loop`
 *   in that repo's own workspace, never a board pane.
 * - **Startup hooks re-run on live handoff.** A guard file per repo alias
 *   (plus one for intake) in `HERDR_PLUGIN_STATE_DIR` prevents a second pane
 *   — and a second supervisor racing the first, SPEC §17.4 "the loop is a
 *   singleton" — from being created on every server restore.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalConfig, resolveRepoEntry } from "@foreman/core";
import { defaultRunCommand } from "./actions.ts";

const FOREMAN_WORKSPACE_LABEL = "foreman";
const LOOP_PANE_LABEL = "foreman-loop";
const INTAKE_PANE_LABEL = "foreman-intake";

interface GuardState {
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdAt: string;
}

function guardFileName(key: string): string {
  return `loop-pane-${key}.json`;
}

/**
 * Reads a guard file. A missing or unparseable file means "no pane has been
 * created yet for this key" rather than an error — the common case on first
 * install and for every newly-registered repo alias.
 */
function readGuard(stateDir: string, key: string): GuardState | null {
  const path = join(stateDir, guardFileName(key));
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

function writeGuard(stateDir: string, key: string, guard: GuardState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, guardFileName(key)), JSON.stringify(guard, null, 2));
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
 * Absolute path to the built `foreman` CLI, which lives in a sibling package
 * and carries both `foreman loop` and `foreman intake`. Resolved from the
 * plugin root rather than PATH: in dev-link mode the bin is a workspace
 * symlink that was never installed globally, so PATH cannot be relied on.
 */

function resolveCliEntry(pluginRoot: string): string {
  const entry = join(pluginRoot, "..", "cli", "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(
      `The foreman CLI is not built at ${entry}. Run \`bun run build\` in the Foreman repo, ` +
        `then restart herdr or invoke the startup hook again.`,
    );
  }
  return entry;
}

/** Reuses a workspace labelled `label`, creating one only if none exists (see comment in `ensurePane`). */
async function ensureWorkspace(herdrBin: string, label: string, existingId: string | null): Promise<string> {
  const listed = await runHerdrJson<{ workspaces: Array<{ workspace_id: string; label?: string }> }>(herdrBin, [
    "workspace",
    "list",
  ]);
  const reusable = listed.result?.workspaces?.find((w) => w.label === label);
  const workspaceId = reusable?.workspace_id ?? existingId;
  if (workspaceId) return workspaceId;
  const created = await runHerdrJson<{ workspace: { workspace_id: string } }>(herdrBin, [
    "workspace",
    "create",
    "--label",
    label,
    "--no-focus",
  ]);
  const createdId = created.result?.workspace?.workspace_id ?? null;
  if (!createdId) throw new Error(`Failed to create the ${label} workspace: ${created.stderr}`);
  return createdId;
}

/**
 * Idempotent per-key pane creation: ensures `workspaceLabel`, a tab labelled
 * `paneLabel` (with `cwd`, if given), and `command` running as an ordinary
 * process in that tab's pane, then persists the ids under `guardKey` so a
 * re-run on live handoff verifies liveness instead of rebuilding the layout.
 *
 * `pane run`, not `agent start`. Both the loop and intake are supervisor
 * processes, and `agent start --kind omp` launches an *interactive omp
 * session* in the pane and waits for herdr to recognize it as a coding agent.
 * Measured against herdr 0.8.2, that is exactly what happens: the pane came
 * up as an omp agent sitting at a question prompt, herdr reported
 * `agent_not_ready`, and the supervisor never ran. Agent commands are for
 * things herdr must classify as agents; ordinary processes belong to the
 * pane surface.
 */
async function ensurePane(
  herdrBin: string,
  stateDir: string,
  guardKey: string,
  workspaceLabel: string,
  paneLabel: string,
  cwd: string | null,
  command: string,
): Promise<void> {
  const existing = readGuard(stateDir, guardKey);
  if (existing) {
    // Checks whether the guarded pane still exists before deciding to
    // (re)create it. `pane get` exits 0 for a live pane and non-zero once
    // it is closed, which is the signal that matters here: the hook's
    // contract is "a long-lived pane exists for this key", and a pane whose
    // process has exited still holds the operator's scrollback about why.
    // Deliberately not `agent get`: the loop and intake are ordinary
    // processes, not coding agents, so herdr never registers them under an
    // agent name.
    const { exitCode } = await defaultRunCommand(herdrBin, ["pane", "get", existing.paneId]);
    if (exitCode === 0) return;
  }

  /*
   * Reuse an existing workspace before creating one. `workspace create`
   * always creates, so an unconditional call produces a duplicate every time
   * the guard file is absent — measured against herdr 0.8.2, three
   * workspaces all labelled the same after three startup runs. The
   * operator's own workspace for this repo (or `foreman`) is almost always
   * already there.
   */
  const workspaceId = await ensureWorkspace(herdrBin, workspaceLabel, existing?.workspaceId ?? null);

  const tabArgs = ["tab", "create", "--workspace", workspaceId, "--label", paneLabel, "--no-focus"];
  if (cwd) tabArgs.push("--cwd", cwd);
  const tab = await runHerdrJson<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(herdrBin, tabArgs);
  const tabId = tab.result?.tab?.tab_id;
  const paneId = tab.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error(`Failed to create the ${paneLabel} tab: ${tab.stderr}`);

  const launch = await defaultRunCommand(herdrBin, ["pane", "run", paneId, command]);
  if (launch.exitCode !== 0) {
    throw new Error(`Failed to start ${paneLabel} in pane ${paneId}: ${launch.stderr}`);
  }

  writeGuard(stateDir, guardKey, { workspaceId, tabId, paneId, createdAt: new Date().toISOString() });
}

/**
 * Idempotent startup: ensures one `foreman-loop` pane per registry repo
 * (workspace labelled with the repo's alias, per SPEC §17.3's "one workspace
 * per repo") plus the shared `foreman intake` pane in the `foreman`
 * workspace (SPEC §3.12, §17.3, §17.4).
 */
export async function runStartup(env: Record<string, string | undefined> = process.env): Promise<void> {
  const herdrBin = env.HERDR_BIN_PATH ?? "herdr";
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set; cannot guard against double-start.");
  const pluginRoot = env.HERDR_PLUGIN_ROOT;
  if (!pluginRoot) throw new Error("HERDR_PLUGIN_ROOT is not set; cannot locate the foreman CLI.");

  const cliEntry = resolveCliEntry(pluginRoot);
  const { config } = loadGlobalConfig({ env });

  for (const alias of Object.keys(config.repos)) {
    const entry = resolveRepoEntry(config, alias);
    await ensurePane(
      herdrBin,
      stateDir,
      alias,
      alias,
      LOOP_PANE_LABEL,
      entry.repoPath,
      `exec bun run ${JSON.stringify(cliEntry)} loop`,
    );
  }

  await ensurePane(
    herdrBin,
    stateDir,
    "intake",
    FOREMAN_WORKSPACE_LABEL,
    INTAKE_PANE_LABEL,
    null,
    `exec bun run ${JSON.stringify(cliEntry)} intake`,
  );
}

if (import.meta.main) {
  await runStartup();
}
