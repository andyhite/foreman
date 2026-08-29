/**
 * Start-or-attach process control for the two loops the TUI manages.
 *
 * The TUI is a client of the control socket, never the loop itself — but an
 * operator opening `foreman tui` usually has nothing running yet, so this is
 * the one place that spawns a detached `foreman loop`/`foreman intake`
 * process and waits for its socket, mirroring what an operator would type by
 * hand. A failed spawn must never take the TUI down: every path here returns
 * a `SpawnResult` instead of throwing, and points at the loop's own log file
 * for the real failure.
 */

import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import type { GlobalConfig, LoopId } from "@foreman/core";
import {
  INTAKE_LOOP_ID,
  loopPaths,
  parseLoopId,
  pidAlive,
  probeSocket,
  readLoopLock,
  waitForSocket,
} from "@foreman/core";

export interface SpawnResult {
  started: boolean;
  pid: number | null;
  message: string;
}

export interface SuperviseOptions {
  config: GlobalConfig;
  home?: string;
  log?: (m: string) => void;
}

/**
 * Resolves the command this process was launched with, so a spawned loop
 * runs the exact same entry point (built bundle or `bun run src/main.ts`)
 * rather than guessing at an installed `foreman` binary on PATH.
 */
export function resolveForemanCommand(): { command: string; baseArgs: string[] } {
  const entry = process.argv[1];
  if (entry) return { command: process.execPath, baseArgs: [entry] };
  return { command: "foreman", baseArgs: [] };
}

export async function loopRunning(config: GlobalConfig, id: LoopId, home?: string): Promise<boolean> {
  const paths = loopPaths(config, id, home);
  const lock = readLoopLock(paths.lock);
  if (!lock || !pidAlive(lock.pid)) return false;
  return probeSocket(paths.socket, 500);
}

export async function killLoop(config: GlobalConfig, id: LoopId, home?: string): Promise<boolean> {
  const paths = loopPaths(config, id, home);
  const lock = readLoopLock(paths.lock);
  if (!lock || !pidAlive(lock.pid)) return false;
  try {
    process.kill(lock.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function startLoop(
  id: LoopId,
  options: SuperviseOptions & { team?: string | null },
): Promise<SpawnResult> {
  const { config, home, log } = options;
  const paths = loopPaths(config, id, home);

  if (await loopRunning(config, id, home)) {
    const lock = readLoopLock(paths.lock);
    return { started: false, pid: lock?.pid ?? null, message: `already running (pid ${lock?.pid ?? "?"})` };
  }

  const { kind, alias } = parseLoopId(id);
  const { command, baseArgs } = resolveForemanCommand();
  const args = [...baseArgs, kind === "intake" ? "intake" : "loop"];
  if (kind === "repo" && alias) args.push("--repo", alias);
  if (kind === "intake" && options.team) args.push("--team", options.team);
  if (home) args.push("--home", home);

  let fd: number;
  try {
    fd = openSync(paths.log, "a");
  } catch (error) {
    return { started: false, pid: null, message: `could not open log file ${paths.log}: ${String(error)}` };
  }

  log?.(`starting ${id}: ${command} ${args.join(" ")}`);

  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
  } catch (error) {
    return { started: false, pid: null, message: `spawn failed: ${String(error)}` };
  }
  child.unref();

  const info = await waitForSocket(paths.socket, 15000);
  if (!info) {
    return {
      started: false,
      pid: child.pid ?? null,
      message: `${id} did not come up within 15s; see ${paths.log}`,
    };
  }
  return { started: true, pid: child.pid ?? null, message: `started (pid ${child.pid ?? "?"})` };
}

/** Convenience for callers that only have the loop kind, not a parsed id — the intake loop's id is fixed. */
export function loopIdForKind(kind: "repo" | "intake", alias: string | null): LoopId {
  return kind === "intake" ? INTAKE_LOOP_ID : `repo:${alias ?? ""}`;
}
