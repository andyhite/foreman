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
 * to a short, deterministic path under the OS temp directory whenever the
 * natural one would risk the limit.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
}

export function stateRoot(config: GlobalConfig, home?: string): string {
  return expandHome(config.loop.stateDir, home);
}

/** A conservative ceiling: the kernel caps `sun_path` at 104 bytes on macOS; leave room for a NUL and the basename. */
const SOCKET_PATH_SAFE_LIMIT = 100;

function socketPathFor(dir: string): string {
  const candidate = join(dir, "control.sock");
  if (candidate.length <= SOCKET_PATH_SAFE_LIMIT) return candidate;
  const digest = createHash("sha1").update(dir).digest("hex").slice(0, 16);
  return join(tmpdir(), `foreman-${digest}.sock`);
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
  };
}
