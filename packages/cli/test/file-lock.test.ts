import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/file-lock.ts";

describe("withFileLock", () => {
  it("does not busy-loop when a directory occupies the lock path", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-file-lock-"));
    const lockPath = join(dir, "lock");
    mkdirSync(lockPath);

    const start = Date.now();
    const result = withFileLock(lockPath, () => "acquired", 200);
    const elapsed = Date.now() - start;

    expect(result).toBe("acquired");
    expect(elapsed).toBeLessThan(1000);

    rmSync(dir, { force: true, recursive: true });
  });
});
