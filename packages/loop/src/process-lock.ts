/**
 * Singleton lockfile for `foreman plan`/`foreman build` (simplification plan
 * Phase 4), one per `<stateDir>/<alias>/<loopName>.lock`. Two loops for the
 * same alias racing the same Linear state is the failure mode that corrupts
 * dispatch bookkeeping rather than just wasting tokens, so a second
 * `acquire()` against a live holder throws, and a holder whose pid is dead
 * (the process crashed without releasing) is taken over rather than left to
 * block the loop forever. Ported from the deleted `supervisor.ts`'s
 * `SupervisorLock`, unchanged in mechanics, keyed per-loop instead of
 * per-alias.
 */

import { dirname } from "node:path";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface ProcessLockInfo {
  pid: number;
  startedAt: string;
  /** Unique per `acquire()` call: the only way `release()` can tell "my lock" from a lock a later reclaim replaced it with. */
  token: string;
}

export class ProcessLockHeldError extends Error {
  constructor(info: ProcessLockInfo, path: string) {
    super(`a foreman process is already running (pid ${info.pid}, started ${info.startedAt}). Lock file: ${path}`);
    this.name = "ProcessLockHeldError";
  }
}

/** Seam over `process.kill(pid, 0)`, so tests can simulate a dead pid without spawning one. */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /**
   * Test seam only: invoked between unlinking the observed-stale lock and
   * exclusively `link`ing the reclaim temp file into place — the exact
   * window a genuine second reclaimer could win. Lets a test simulate that
   * race deterministically instead of racing real processes.
   */
  onReclaiming?(): void;
}

export const nodeProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * A stale reclaim never blindly unlinks-then-writes: two processes racing
 * the same dead holder could otherwise both believe they won. The reclaim
 * writes a temp file, unlinks the observed-stale path, then `link`s the
 * temp file into place — `link(2)` fails atomically with `EEXIST` if a
 * concurrent reclaimer's file is already there (a plain `rename` would
 * silently overwrite it instead), so exactly one reclaimer wins. The
 * on-disk token read-back stays as a second line of defence. Each
 * `acquire()` mints a random `token`; `release()` only unlinks the file
 * when its on-disk token still matches this instance's, so a departing
 * loser never deletes the winner's lock.
 */
export class ProcessLock {
  readonly #path: string;
  #acquired = false;
  #token: string | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  acquire(pid: number, now: Date, probe: ProcessProbe = nodeProcessProbe): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const token = randomUUID();
    const info: ProcessLockInfo = { pid, startedAt: now.toISOString(), token };
    try {
      writeFileSync(this.#path, JSON.stringify(info, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      this.#acquired = true;
      this.#token = token;
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }

    let existing: ProcessLockInfo | null = null;
    try {
      existing = JSON.parse(readFileSync(this.#path, "utf8")) as ProcessLockInfo;
    } catch {
      // A truncated lock cannot prove a live owner. Treat it like any stale
      // lock and retry the reclaim below.
    }
    if (existing && probe.isAlive(existing.pid)) throw new ProcessLockHeldError(existing, this.#path);

    const tempPath = `${this.#path}.${token}`;
    writeFileSync(tempPath, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      unlinkSync(this.#path);
    } catch {
      // Already gone — a prior reclaimer's cleanup or a crash that left no
      // file at all. Either way there's nothing to remove.
    }
    probe.onReclaiming?.();
    try {
      linkSync(tempPath, this.#path);
    } catch (error) {
      unlinkSync(tempPath);
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      let winner: ProcessLockInfo | null = null;
      try {
        winner = JSON.parse(readFileSync(this.#path, "utf8")) as ProcessLockInfo;
      } catch {
        winner = null;
      }
      throw new ProcessLockHeldError(winner ?? info, this.#path);
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort: the link succeeded, `this.#path` already carries our data.
    }

    let reclaimed: ProcessLockInfo | null = null;
    try {
      reclaimed = JSON.parse(readFileSync(this.#path, "utf8")) as ProcessLockInfo;
    } catch {
      reclaimed = null;
    }
    if (!reclaimed || reclaimed.token !== token) {
      throw new ProcessLockHeldError(reclaimed ?? info, this.#path);
    }
    this.#acquired = true;
    this.#token = token;
  }

  release(): void {
    if (this.#acquired) {
      try {
        const current = JSON.parse(readFileSync(this.#path, "utf8")) as ProcessLockInfo;
        if (current.token === this.#token) unlinkSync(this.#path);
      } catch {
        // Corrupt or unreadable: nothing safe to compare the token against,
        // so leave whatever is on disk alone rather than guess.
      }
    }
    this.#acquired = false;
    this.#token = null;
  }

  get acquired(): boolean {
    return this.#acquired;
  }
}
