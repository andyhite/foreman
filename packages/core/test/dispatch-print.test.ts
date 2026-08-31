import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "../src/config/schema.ts";
import { PrintDispatcher } from "../src/dispatch/print.ts";

/** A fake `omp` binary: ignores every argument and exits with the given code. */
function fakeOmpBin(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-fake-omp-"));
  const path = join(dir, "fake-omp.sh");
  writeFileSync(path, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function makeConfig(ompBin: string): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2, plan: 1 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      stage: "full",
      workerStages: {},
      mergeDetection: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql" },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin, approvalMode: "yolo", herdrBin: "herdr" },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

describe("PrintDispatcher.settle (SPEC §17.8: retained logs must be pruned on settle)", () => {
  it("prunes the internal running entry once settle resolves", async () => {
    const ompBin = fakeOmpBin(1);
    const dispatcher = new PrintDispatcher(makeConfig(ompBin));
    const handle = await dispatcher.dispatch({
      agent: "foreman-implement",
      issueId: "ENG-1",
      command: "/foreman:implement ENG-1",
      dispatchId: "foreman-implement-ENG-1-20260601T120000Z-abc123",
      cwd: tmpdir(),
    });

    const outcome = await dispatcher.settle(handle);
    expect(outcome.status).toBe("settled");
    expect(outcome.exitCode).toBe(1);

    // A second `settle()` for the same handle proves the entry was pruned:
    // if it were still retained, this would resolve the same outcome again
    // (exitCode 1); once pruned, `settle` falls back to its "never tracked"
    // default (exitCode null).
    const second = await dispatcher.settle(handle);
    expect(second.exitCode).toBeNull();
  });
});
