import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatcher, DispatchHandle, DispatchOutcome, DispatchRequest, DispatchStatus, GlobalConfig } from "@foreman/core";
import {
  LoopLockHeldError,
  SupervisorLock,
  lockPathFor,
  resolveDispatcher,
  type ProcessProbe,
} from "../src/supervisor.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-supervisor-"));
}

class FakeDispatcher implements Dispatcher {
  readonly kind: "print" | "herdr";
  #available: boolean;

  constructor(kind: "print" | "herdr", available: boolean) {
    this.kind = kind;
    this.#available = available;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle> {
    return {
      dispatchId: request.dispatchId,
      agent: request.agent,
      issueId: request.issueId,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: null,
    };
  }

  async status(): Promise<DispatchStatus> {
    return "settled";
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return { handle, status: "settled", exitCode: 0, log: "" };
  }

  async available(): Promise<boolean> {
    return this.#available;
  }
}

function makeConfig(dispatcher: GlobalConfig["loop"]["dispatcher"]): GlobalConfig {
  return {
    repos: {},
    loop: {
      wipGlobal: 3,
      wip: { triage: 1, refine: 2, implement: 3, review: 2 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      triageWindow: "06:00",
      stage: "dry-run",
      dispatcher,
      mergeDetection: true,
      stateDir: "~/.foreman/state",
    },
    triage: { staleLowDays: 90, batchSize: 20 },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, teamKeys: [], endpoint: "https://api.linear.app/graphql" },
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

describe("SupervisorLock", () => {
  it("refuses a second holder while the first pid is live", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const alwaysAlive: ProcessProbe = { isAlive: () => true };

    const first = new SupervisorLock(path);
    first.acquire(111, now, alwaysAlive);
    expect(existsSync(path)).toBe(true);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, alwaysAlive)).toThrow(LoopLockHeldError);

    // The lock file still names the first holder — the second acquire never
    // clobbered it.
    const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(info.pid).toBe(111);
  });

  it("releases on shutdown, freeing the lock for the next holder", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const alwaysAlive: ProcessProbe = { isAlive: () => true };

    const first = new SupervisorLock(path);
    first.acquire(111, now, alwaysAlive);
    first.release();
    expect(existsSync(path)).toBe(false);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, alwaysAlive)).not.toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it("takes over a stale lock whose pid is dead", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const dead: ProcessProbe = { isAlive: () => false };

    const first = new SupervisorLock(path);
    first.acquire(111, now, dead);

    const second = new SupervisorLock(path);
    expect(() => second.acquire(222, now, dead)).not.toThrow();

    const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(info.pid).toBe(222);
  });

  it("release is a no-op when the lock was never acquired by this instance", () => {
    const stateDir = tempStateDir();
    const path = lockPathFor(stateDir);
    const lock = new SupervisorLock(path);
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("resolveDispatcher", () => {
  it("uses print mode when loop.dispatcher is \"print\"", async () => {
    const config = makeConfig("print");
    const logs: string[] = [];
    const dispatcher = await resolveDispatcher(
      config,
      {
        createPrint: () => new FakeDispatcher("print", true),
        createHerdr: () => new FakeDispatcher("herdr", true),
      },
      (message) => logs.push(message),
    );
    expect(dispatcher.kind).toBe("print");
    expect(logs).toHaveLength(0);
  });

  it("uses herdr when configured and available", async () => {
    const config = makeConfig("herdr");
    const dispatcher = await resolveDispatcher(
      config,
      {
        createPrint: () => new FakeDispatcher("print", true),
        createHerdr: () => new FakeDispatcher("herdr", true),
      },
      () => {},
    );
    expect(dispatcher.kind).toBe("herdr");
  });

  it("falls back to print when herdr is configured but unavailable, and logs the fallback", async () => {
    const config = makeConfig("herdr");
    const logs: string[] = [];
    const dispatcher = await resolveDispatcher(
      config,
      {
        createPrint: () => new FakeDispatcher("print", true),
        createHerdr: () => new FakeDispatcher("herdr", false),
      },
      (message) => logs.push(message),
    );
    expect(dispatcher.kind).toBe("print");
    expect(logs.some((line) => line.toLowerCase().includes("herdr") && line.toLowerCase().includes("fall"))).toBe(true);
  });
});
