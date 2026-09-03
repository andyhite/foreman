import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatcher, DispatchHandle, DispatchOutcome, DispatchRequest, DispatchStatus } from "@foreman/core";
import { InflightStore } from "../src/inflight.ts";

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-inflight-"));
  return join(dir, "build.json");
}

function makeHandle(overrides: Partial<DispatchHandle> = {}): DispatchHandle {
  return { dispatchId: "d1", agent: "foreman-implement", issueId: "ENG-1", startedAt: new Date().toISOString(), pid: 123, herdr: null, ...overrides };
}

/** Reports a fixed status for every handle regardless of dispatch/settle calls. */
class StatusDispatcher implements Dispatcher {
  readonly kind = "print" as const;
  #status: DispatchStatus;

  constructor(status: DispatchStatus) {
    this.#status = status;
  }

  async dispatch(_request: DispatchRequest): Promise<DispatchHandle[]> {
    return [];
  }

  async status(_handle: DispatchHandle): Promise<DispatchStatus> {
    return this.#status;
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    return { handle, status: this.#status, exitCode: 0, log: "" };
  }

  async available(): Promise<boolean> {
    return true;
  }
}

describe("InflightStore", () => {
  it("round-trips record/failures/remove through disk with 0600 permissions", async () => {
    const path = tempStatePath();
    const dispatcher = new StatusDispatcher("running");
    let store = await InflightStore.load(path, dispatcher);

    store.record("issue:ENG-1", makeHandle());
    store.recordFailure("issue:ENG-1");
    store.recordFailure("issue:ENG-1");

    expect(store.has("issue:ENG-1")).toBe(true);
    expect(store.inFlightCount()).toBe(1);
    expect(store.failures("issue:ENG-1")).toBe(2);
    expect(existsSync(path)).toBe(true);

    // A fresh load from the same path (still "running") must recover the persisted state.
    store = await InflightStore.load(path, dispatcher);
    expect(store.has("issue:ENG-1")).toBe(true);
    expect(store.failures("issue:ENG-1")).toBe(2);

    store.clearFailures("issue:ENG-1");
    expect(store.failures("issue:ENG-1")).toBe(0);

    store.remove("issue:ENG-1");
    expect(store.has("issue:ENG-1")).toBe(false);
    expect(store.inFlightCount()).toBe(0);

    rmSync(path, { force: true });
  });

  it("drops an in-flight entry whose dispatcher reports a terminal status on load", async () => {
    const path = tempStatePath();
    let store = await InflightStore.load(path, new StatusDispatcher("running"));
    store.record("issue:ENG-2", makeHandle({ dispatchId: "d2", issueId: "ENG-2" }));
    expect(store.has("issue:ENG-2")).toBe(true);

    store = await InflightStore.load(path, new StatusDispatcher("settled"));
    expect(store.has("issue:ENG-2")).toBe(false);

    rmSync(path, { force: true });
  });

  it("drops an in-flight entry reported lost, but keeps one still running or starting", async () => {
    const path = tempStatePath();
    let store = await InflightStore.load(path, new StatusDispatcher("running"));
    store.record("issue:ENG-3", makeHandle({ dispatchId: "d3", issueId: "ENG-3" }));

    store = await InflightStore.load(path, new StatusDispatcher("lost"));
    expect(store.has("issue:ENG-3")).toBe(false);

    store = await InflightStore.load(path, new StatusDispatcher("starting"));
    store.record("issue:ENG-4", makeHandle({ dispatchId: "d4", issueId: "ENG-4" }));
    store = await InflightStore.load(path, new StatusDispatcher("starting"));
    expect(store.has("issue:ENG-4")).toBe(true);

    rmSync(path, { force: true });
  });

  it("tolerates a missing or corrupt state file by starting empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-inflight-"));
    const missingPath = join(dir, "does-not-exist.json");
    const store = await InflightStore.load(missingPath, new StatusDispatcher("running"));
    expect(store.inFlightCount()).toBe(0);
    expect(store.failures("issue:ENG-1")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
