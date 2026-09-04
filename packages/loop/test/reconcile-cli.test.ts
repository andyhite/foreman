import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveDispatchIds } from "../src/reconcile-cli.ts";

describe("readLiveDispatchIds", () => {
  it("returns an empty set when there is no lock for the loop", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "foreman-reconcile-cli-"));
    try {
      mkdirSync(join(stateDir, "acme"), { recursive: true });
      writeFileSync(
        join(stateDir, "acme", "build.json"),
        JSON.stringify({ inFlight: { "eng-1": { handle: { dispatchId: "dispatch-1" } } } }),
      );

      const ids = readLiveDispatchIds(stateDir, "acme", undefined);

      expect(ids.size).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns the entry's dispatch id when the lock names a live pid", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "foreman-reconcile-cli-"));
    try {
      mkdirSync(join(stateDir, "acme"), { recursive: true });
      writeFileSync(
        join(stateDir, "acme", "build.json"),
        JSON.stringify({ inFlight: { "eng-1": { handle: { dispatchId: "dispatch-1" } } } }),
      );
      writeFileSync(
        join(stateDir, "acme", "build.lock"),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "t" }),
      );

      const ids = readLiveDispatchIds(stateDir, "acme", undefined);

      expect(ids).toEqual(new Set(["dispatch-1"]));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
