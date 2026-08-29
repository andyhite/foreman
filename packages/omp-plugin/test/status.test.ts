import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopSnapshot } from "@foreman/core";
import { readLoopState } from "../src/commands/status.ts";

const snapshot: LoopSnapshot = {
  loop: { id: "repo:test", kind: "repo", label: "test", alias: "test", team: null, repoPath: "/tmp/test", initiativeIds: [], pid: 1, startedAt: "2026-01-01T00:00:00.000Z", version: "test" },
  runtime: { state: "running", stage: "full", dryRun: false, dispatcher: "none", pausedAt: null, lastTickAt: null, nextTickAt: null, ticks: 1, uptimeMs: 1 },
  workers: [], agents: [],
  wip: { global: { used: 0, cap: 1 }, byStage: [] },
  backpressure: { tripped: false, blockedCount: 0, threshold: 1, reason: null },
  board: { backlog: 0, todo: 0, inProgress: 0, inReview: 0, blocked: 0, proposals: 0, readyBuffer: 0, triageInbox: 0 },
  queues: { blocked: [], proposals: [], decisions: [], pipeline: [] },
  linear: { ok: true, lastPollAt: null, lastError: null, requests: 0 },
  history: { dispatchesPerTick: [] },
};

describe("readLoopState", () => {
  it("marks a status file older than the registry threshold as stopped/stale", () => {
    const directory = mkdtempSync(join(tmpdir(), "foreman-status-"));
    const path = join(directory, "status.json");
    try {
      writeFileSync(path, JSON.stringify({ schema: 1, writtenAt: "2026-01-01T00:00:00.000Z", snapshot }));
      const state = readLoopState(path, new Date("2026-01-01T00:01:31.000Z"));
      expect(state.loop.stage).toBe("stopped/stale");
      expect(state.agents).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
