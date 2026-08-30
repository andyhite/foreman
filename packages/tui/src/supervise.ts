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

import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import type { GlobalConfig, LoopId } from "@foreman/core";
import {
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
    mkdirSync(paths.dir, { recursive: true });
    fd = openSync(paths.log, "a");
  } catch (error) {
    return { started: false, pid: null, message: `could not open log file ${paths.log}: ${String(error)}` };
  }

  log?.(`starting ${id}: ${command} ${args.join(" ")}`);

  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
  } catch (error) {
    closeSync(fd);
    return { started: false, pid: null, message: `spawn failed: ${String(error)}` };
  }
  // `spawn` reports most launch failures (unresolvable binary, EACCES) through
  // the child's `error` event, not a thrown exception — with no listener that
  // is an uncaught exception that takes the whole TUI process down.
  const spawnError = new Promise<Error | null>((resolve) => {
    child.once("error", resolve);
    child.once("spawn", () => resolve(null));
  });
  child.unref();
  // Node never closes descriptors it hands to a child through `stdio`; the
  // child has its own reference to the fd via dup(), so the parent's copy
  // must be closed explicitly or every `s` press leaks one.
  closeSync(fd);

  const failure = await spawnError;
  if (failure) {
    return { started: false, pid: null, message: `spawn failed: ${String(failure)}` };
  }

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

