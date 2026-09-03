import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Exclusive advisory lock via `O_EXCL` create. Used to serialize the
 * read-modify-write of `~/.foreman/config.json`: the write itself is atomic,
 * but two writers merging concurrently would drop one another's registry entry.
 * A lock whose recorded pid is gone is stale and reclaimed — a crashed `init`
 * must not wedge every later one.
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
      if (Date.now() > deadline) {
        unlinkSync(lockPath);
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
