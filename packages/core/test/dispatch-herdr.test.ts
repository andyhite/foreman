import { describe, expect, it } from "bun:test";
import type { GlobalConfig } from "../src/config/schema.ts";
import {
  HerdrDispatcher,
  HerdrUnavailableError,
  isHerdrUnavailable,
} from "../src/dispatch/herdr.ts";

function makeConfig(): GlobalConfig {
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
      mode: "confirm",
      workerModes: {},
      mergeDetection: true,
      stateDir: "~/.foreman/state",
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20, timezone: "UTC" },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql" },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr" },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

const unavailableRunner = {
  run() {
    return Promise.reject(new HerdrUnavailableError("herdr workspace list timed out after 30000ms"));
  },
};

describe("HerdrDispatcher timeouts", () => {
  it("propagates HerdrUnavailableError from hung subprocess calls", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    await expect(
      dispatcher.dispatch({
        agent: "foreman-refine",
        issueId: "ENG-1",
        command: "/foreman:refine ENG-1",
        dispatchId: "dispatch-1",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(HerdrUnavailableError);
  });

  it("treats HerdrUnavailableError as unavailable in available()", async () => {
    const dispatcher = new HerdrDispatcher(makeConfig(), { runner: unavailableRunner });
    await expect(dispatcher.available()).resolves.toBe(false);
  });

  it("classifies HerdrUnavailableError with isHerdrUnavailable", () => {
    expect(isHerdrUnavailable(new HerdrUnavailableError("timed out"))).toBe(true);
    expect(isHerdrUnavailable(new Error("other"))).toBe(false);
  });
});
