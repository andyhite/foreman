import { describe, expect, it } from "bun:test";
import type { DispatchHandle, DispatchOutcome, DispatchStatus, Dispatcher } from "@foreman/core";
import { FallbackDispatcher } from "../src/dispatch/resolve.ts";

class FakeDispatcher implements Dispatcher {
  readonly kind: "print" | "herdr";
  statusCalls: DispatchHandle[] = [];
  settleCalls: DispatchHandle[] = [];

  constructor(kind: "print" | "herdr") {
    this.kind = kind;
  }

  async dispatch(): Promise<DispatchHandle[]> {
    throw new Error("not used in this test");
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    this.statusCalls.push(handle);
    return "running";
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    this.settleCalls.push(handle);
    return { handle, status: "settled", exitCode: 0, log: "" };
  }

  async available(): Promise<boolean> {
    return true;
  }
}

function herdrHandle(dispatchId: string): DispatchHandle {
  return {
    dispatchId,
    agent: "foreman-implement",
    issueId: "ENG-1",
    startedAt: new Date().toISOString(),
    pid: null,
    herdr: { paneId: "p1", agentName: "agent-1" },
  };
}

function printHandle(dispatchId: string): DispatchHandle {
  return {
    dispatchId,
    agent: "foreman-implement",
    issueId: "ENG-2",
    startedAt: new Date().toISOString(),
    pid: 123,
    herdr: null,
  };
}

describe("FallbackDispatcher.status/settle — restart routing", () => {
  it("routes a herdr-shaped handle absent from #owner to the primary (herdr) dispatcher", async () => {
    const primary = new FakeDispatcher("herdr");
    const fallback = new FakeDispatcher("print");
    const dispatcher = new FallbackDispatcher(primary, fallback);
    const handle = herdrHandle("dispatch-after-restart");

    await dispatcher.status(handle);
    await dispatcher.settle(handle);

    expect(primary.statusCalls).toEqual([handle]);
    expect(primary.settleCalls).toEqual([handle]);
    expect(fallback.statusCalls).toEqual([]);
    expect(fallback.settleCalls).toEqual([]);
  });

  it("routes a non-herdr handle absent from #owner to the print fallback", async () => {
    const primary = new FakeDispatcher("herdr");
    const fallback = new FakeDispatcher("print");
    const dispatcher = new FallbackDispatcher(primary, fallback);
    const handle = printHandle("dispatch-print-after-restart");

    await dispatcher.status(handle);

    expect(fallback.statusCalls).toEqual([handle]);
    expect(primary.statusCalls).toEqual([]);
  });

  it("still routes a tracked handle to whichever dispatcher actually ran it, regardless of handle shape", async () => {
    const primary = new FakeDispatcher("herdr");
    const fallback = new FakeDispatcher("print");
    const dispatcher = new FallbackDispatcher(primary, fallback);

    primary.dispatch = async () => [herdrHandle("dispatch-tracked")];
    const handles = await dispatcher.dispatch({ agent: "foreman-implement", command: "/foreman:implement", cwd: "/repo", alias: "product", items: [] });
    await dispatcher.status(handles[0]!);

    expect(primary.statusCalls).toEqual([handles[0]!]);
    expect(fallback.statusCalls).toEqual([]);
  });
});
