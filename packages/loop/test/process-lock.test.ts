import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessLock, ProcessLockHeldError, type ProcessProbe } from "../src/process-lock.ts";

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-lock-"));
  return join(dir, "build.lock");
}

const ALWAYS_ALIVE: ProcessProbe = { isAlive: () => true };
const ALWAYS_DEAD: ProcessProbe = { isAlive: () => false };

describe("ProcessLock", () => {
  it("acquires a fresh lock and releases it, leaving no file behind", () => {
    const path = tempLockPath();
    const lock = new ProcessLock(path);

    lock.acquire(111, new Date("2026-06-01T12:00:00.000Z"), ALWAYS_ALIVE);
    expect(lock.acquired).toBe(true);
    expect(existsSync(path)).toBe(true);

    lock.release();
    expect(lock.acquired).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("throws ProcessLockHeldError against a live holder and leaves that holder's lock untouched", () => {
    const path = tempLockPath();
    const holder = new ProcessLock(path);
    holder.acquire(111, new Date("2026-06-01T12:00:00.000Z"), ALWAYS_ALIVE);

    const challenger = new ProcessLock(path);
    expect(() => challenger.acquire(222, new Date("2026-06-01T12:05:00.000Z"), ALWAYS_ALIVE)).toThrow(ProcessLockHeldError);
    expect(challenger.acquired).toBe(false);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(111);

    holder.release();
  });

  it("reclaims a lock whose holder pid is dead", () => {
    const path = tempLockPath();
    const holder = new ProcessLock(path);
    holder.acquire(111, new Date("2026-06-01T12:00:00.000Z"), ALWAYS_DEAD);

    const successor = new ProcessLock(path);
    successor.acquire(222, new Date("2026-06-01T12:10:00.000Z"), ALWAYS_DEAD);
    expect(successor.acquired).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(222);

    successor.release();
  });

  it("a departing loser's release never deletes the winner's reclaimed lock", () => {
    const path = tempLockPath();
    const holder = new ProcessLock(path);
    holder.acquire(111, new Date("2026-06-01T12:00:00.000Z"), ALWAYS_DEAD);

    const successor = new ProcessLock(path);
    successor.acquire(222, new Date("2026-06-01T12:10:00.000Z"), ALWAYS_DEAD);

    // The original holder's release() compares its own stale token against the
    // now-different on-disk token and must not unlink the successor's lock.
    holder.release();
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(222);

    successor.release();
  });

  it("treats a truncated lock file as stale and reclaims it", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-lock-"));
    const path = join(dir, "build.lock");

    writeFileSync(path, "not json", { mode: 0o600 });

    const lock = new ProcessLock(path);
    lock.acquire(333, new Date("2026-06-01T12:00:00.000Z"), ALWAYS_ALIVE);
    expect(lock.acquired).toBe(true);

    lock.release();
    rmSync(dir, { recursive: true, force: true });
  });
});
