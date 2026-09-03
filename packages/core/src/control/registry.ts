/**
 * Loop discovery (SPEC §17).
 *
 * Nothing centrally tracks which loops exist beyond the config's `repos`
 * registry plus the always-present intake loop — so "what loops are there,
 * and are they alive" is derived fresh each time from three cheap,
 * independent signals: the lock file (did a process claim this state dir),
 * the pid inside it (is that process still alive), and the control socket
 * (does it still speak the protocol, not just exist as a stale inode). A
 * fourth, `status.json`, is read as a fallback view for a client that only
 * wants a snapshot and does not want to pay for a socket round trip, or
 * whose reachability probe just failed.
 *
 * Every write here mirrors `Bookkeeping.save()` in `packages/loop` — atomic
 * temp-then-rename — so a client mid-read of `status.json` never observes a
 * half-written file, without needing a lock of its own.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { expandHome } from "../config/load.ts";
import { Value } from "../typebox.ts";
import type { GlobalConfig } from "../config/schema.ts";
import { INTAKE_LOOP_ID, type LoopId, type LoopKind, type LoopPaths, loopPaths, repoLoopId } from "./paths.ts";
import { probeSocket } from "./client.ts";
import { type LoopSnapshot, type StatusFile, StatusFileSchema } from "./protocol.ts";

export interface LoopHandle {
  id: LoopId;
  kind: LoopKind;
  label: string;
  alias: string | null;
  repoPath: string | null;
  paths: LoopPaths;
  /** Lock exists and its pid is alive. */
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  /** Control socket answered `hello`. */
  reachable: boolean;
  status: StatusFile | null;
  /** status.json older than `staleAfterMs`. */
  staleStatus: boolean;
}

export interface DiscoverOptions {
  home?: string;
  probe?: boolean;
  staleAfterMs?: number;
}

/** How old `status.json` may be before it's treated as a dead loop rather than
 * a healthy one between poll ticks — two cadences plus a margin, since a
 * fixed threshold shorter than the loop's own publish interval reports a
 * healthy loop as stale for most of every cycle. */
export function statusStaleThresholdMs(cadenceMinutes: number): number {
  return cadenceMinutes * 2 * 60_000 + 30_000;
}

/** Mirrors `nodeProcessProbe` in `packages/loop/src/supervisor.ts` — the two must agree on what "alive" means for the same lock files. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLoopLock(path: string): { pid: number; startedAt: string } | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function readStatusFile(path: string): StatusFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Value.Check(StatusFileSchema, parsed) ? (parsed as StatusFile) : null;
  } catch {
    return null;
  }
}

/** Atomic temp+rename, matching `Bookkeeping.save()`. Validated against the same schema `readStatusFile`
 * enforces so a bad snapshot never publishes a file every reader then silently treats as "no loop". */
export function writeStatusFile(path: string, snapshot: LoopSnapshot): void {
  const statusFile: StatusFile = { schema: 1, writtenAt: new Date().toISOString(), snapshot };
  if (!Value.Check(StatusFileSchema, statusFile)) {
    console.error(`refusing to write ${path}: snapshot fails StatusFileSchema validation`);
    return;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(statusFile, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

async function buildHandle(
  config: GlobalConfig,
  id: LoopId,
  label: string,
  alias: string | null,
  repoPath: string | null,
  options: Required<Pick<DiscoverOptions, "probe" | "staleAfterMs">>,
  home: string | undefined,
): Promise<LoopHandle> {
  const paths = loopPaths(config, id, home);
  const lock = readLoopLock(paths.lock);
  const running = lock !== null && pidAlive(lock.pid);
  const status = readStatusFile(paths.status);
  const staleStatus =
    status !== null && Date.now() - new Date(status.writtenAt).getTime() > options.staleAfterMs;
  const reachable = options.probe ? await probeSocket(paths.socket) : false;
  return {
    id,
    kind: id === INTAKE_LOOP_ID ? "intake" : "repo",
    label,
    alias,
    repoPath,
    paths,
    running,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    reachable,
    status,
    staleStatus,
  };
}

/** Every registry alias plus the intake loop, in that order, repo aliases sorted. */
export async function discoverLoops(config: GlobalConfig, options: DiscoverOptions = {}): Promise<LoopHandle[]> {
  const home = options.home;
  const resolved = { probe: options.probe ?? true, staleAfterMs: options.staleAfterMs ?? statusStaleThresholdMs(config.loop.cadenceMinutes) };
  const aliases = Object.keys(config.repos).sort();
  const handles = await Promise.all([
    ...aliases.map((alias) => {
      const entry = config.repos[alias];
      const repoPath = entry ? expandHome(entry.path, home) : null;
      return buildHandle(config, repoLoopId(alias), alias, alias, repoPath, resolved, home);
    }),
    buildHandle(config, INTAKE_LOOP_ID, "intake", null, null, resolved, home),
  ]);
  return handles;
}

export async function loopHandle(
  config: GlobalConfig,
  id: LoopId,
  options: DiscoverOptions = {},
): Promise<LoopHandle> {
  const resolved = { probe: options.probe ?? true, staleAfterMs: options.staleAfterMs ?? statusStaleThresholdMs(config.loop.cadenceMinutes) };
  if (id === INTAKE_LOOP_ID) {
    return buildHandle(config, id, "intake", null, null, resolved, options.home);
  }
  const alias = id.startsWith("repo:") ? id.slice("repo:".length) : id;
  const entry = config.repos[alias];
  const repoPath = entry ? expandHome(entry.path, options.home) : null;
  return buildHandle(config, id, alias, alias, repoPath, resolved, options.home);
}
