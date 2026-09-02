/**
 * Control-plane paths (SPEC §17).
 *
 * A running loop — repo or intake — publishes a status file and listens on a
 * unix socket inside its own state directory, alongside the existing
 * `loop.lock`/`bookkeeping.json` this module also names. Keeping every path
 * for a loop in one place means the TUI, the CLI, and the loop process itself
 * never hardcode a basename twice.
 *
 * macOS caps `sockaddr_un.sun_path` at 104 bytes, and Foreman's own state
 * root (`~/.foreman/state/<alias>/control.sock`) already eats a third of
 * that before the alias is even chosen. Rather than fail unpredictably once
 * an operator picks a long alias or a deep `stateDir`, `loopPaths` falls back
 * to a short, deterministic path under a private per-user runtime directory
 * whenever the natural one would risk the limit — never the shared, world-
 * readable OS temp directory (FOREMAN-SEC-003): `$XDG_RUNTIME_DIR` when set
 * (already 0700 and owned by the caller on Linux), else a `foreman-<uid>`
 * directory under `tmpdir()` that this module creates at 0700 and verifies
 * is neither a symlink nor owned by anyone else before trusting it.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import type { GlobalConfig } from "../config/schema.ts";
import { expandHome } from "../config/load.ts";

export type LoopKind = "repo" | "intake";
export type LoopId = string;

export const INTAKE_LOOP_ID: LoopId = "intake";

export function repoLoopId(alias: string): LoopId {
  return `repo:${alias}`;
}

export function parseLoopId(id: LoopId): { kind: LoopKind; alias: string | null } {
  if (id === INTAKE_LOOP_ID) return { kind: "intake", alias: null };
  if (id.startsWith("repo:") && id.length > "repo:".length) {
    return { kind: "repo", alias: id.slice("repo:".length) };
  }
  throw new Error(`unrecognized loop id: ${id}`);
}

/** Repo alias, or "intake" — what the TUI header and tab bar render. */
export function loopLabel(id: LoopId): string {
  const parsed = parseLoopId(id);
  return parsed.kind === "intake" ? "intake" : (parsed.alias as string);
}

export interface LoopPaths {
  dir: string;
  lock: string;
  bookkeeping: string;
  status: string;
  socket: string;
  log: string;
  /** Directory of per-agent dispatch-id reservation files handed to dispatched sessions (SPEC §17.4). */
  reservations: string;
}

export function stateRoot(config: GlobalConfig, home?: string): string {
  return expandHome(config.loop.stateDir, home);
}

/**
 * A private directory for this user's control sockets when the natural path is too long for
 * `sun_path`. Prefers `$XDG_RUNTIME_DIR` (already private on Linux); otherwise creates and
 * verifies a `foreman-<uid>` directory under the OS temp dir so a shared `/tmp` never leaves the
 * socket in a world-readable location (FOREMAN-SEC-003).
 */
/**
 * Rejects a runtime directory that is a symlink or not owned by the current user, matching the
 * check the tmpdir fallback below always ran; `$XDG_RUNTIME_DIR` is trusted by callers unverified
 * elsewhere, but it is still a path an environment variable can point anywhere.
 */
function assertPrivateRuntimeDir(dir: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to use ${dir} for the control socket: it is a symlink`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`refusing to use ${dir} for the control socket: not owned by the current user`);
  }
}

function socketRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    assertPrivateRuntimeDir(xdg);
    return xdg;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = join(tmpdir(), `foreman-${uid}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateRuntimeDir(dir);
  chmodSync(dir, 0o700);
  return dir;
}

/** A conservative ceiling: the kernel caps `sun_path` at 104 bytes on macOS; leave room for a NUL and the basename. */
const SOCKET_PATH_SAFE_LIMIT = 100;

function socketPathFor(dir: string): string {
  const candidate = join(dir, "control.sock");
  if (candidate.length <= SOCKET_PATH_SAFE_LIMIT) return candidate;
  const digest = createHash("sha1").update(dir).digest("hex").slice(0, 16);
  return join(socketRuntimeDir(), `foreman-${digest}.sock`);
}

/** `repo:<alias>` -> `<stateRoot>/<alias>`; `intake` -> `<stateRoot>/intake`. */
export function loopPaths(config: GlobalConfig, id: LoopId, home?: string): LoopPaths {
  const parsed = parseLoopId(id);
  const root = stateRoot(config, home);
  const dir = parsed.kind === "intake" ? join(root, "intake") : join(root, parsed.alias as string);
  return {
    dir,
    lock: join(dir, "loop.lock"),
    bookkeeping: join(dir, "bookkeeping.json"),
    status: join(dir, "status.json"),
    socket: socketPathFor(dir),
    log: join(dir, "loop.log"),
    reservations: join(dir, "reservations"),
  };
}
