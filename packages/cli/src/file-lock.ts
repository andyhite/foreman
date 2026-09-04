import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Exclusive advisory lock via `O_EXCL` create. Used to serialize the
 * read-modify-write of `~/.foreman/config.json`: the write itself is atomic,
 * but two writers merging concurrently would drop one another's registry entry.
 * A lock whose recorded pid is gone is stale and reclaimed immediately — a
 * crashed `init` must not wedge every later one for the full `staleMs` window.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, staleMs = 30_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      let holderGone = false;
      let holderText: string | null = null;
      try {
        holderText = readFileSync(lockPath, "utf8");
        const holderPid = Number.parseInt(holderText.trim(), 10);
        if (Number.isFinite(holderPid)) {
          try {
            process.kill(holderPid, 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") holderGone = true;
          }
        }
      } catch (readError) {
        // Only "the lock vanished between the failed open and this read" is a
        // reason to retry immediately. Anything else (EISDIR from a directory at
        // the lock path, EACCES) must fall through to the deadline/sleep path
        // below, or this loop spins forever with no output.
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      // Between the liveness check above and the removal below, another
      // waiter can observe the same dead holder, reclaim the lock, and
      // write its own live pid. Re-read immediately before unlinking; skip
      // the removal only on a *confirmed* mismatch (a live process already
      // reclaimed it) — if the re-read itself fails (e.g. the lock path is
      // a directory, or it vanished), fall through to removing it, matching
      // the original unconditional reclaim so an unreadable blocker can't
      // wedge this loop forever.
      if (holderGone || Date.now() > deadline) {
        let stillMatches = true;
        try {
          stillMatches = readFileSync(lockPath, "utf8") === holderText;
        } catch {
          stillMatches = true;
        }
        if (stillMatches) rmSync(lockPath, { force: true, recursive: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
    } catch {
      // Another process already reclaimed it as stale; nothing to release.
    }
  }
}
