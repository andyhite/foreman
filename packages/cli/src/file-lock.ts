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
      try {
        const holderPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isFinite(holderPid)) {
          try {
            process.kill(holderPid, 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") holderGone = true;
          }
        }
      } catch {
        // Lock file vanished between the failed open and this read — another
        // process already reclaimed it; loop around and try the open again.
        continue;
      }
      if (holderGone) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        rmSync(lockPath, { force: true });
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
