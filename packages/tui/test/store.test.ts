import { describe, expect, it } from "bun:test";
import type { LoopHandle, LoopId, LoopSnapshot } from "@foreman/core";
import { type AppState, initialState, reduce, resetToastIdForTest } from "../src/store.ts";
import { VIEW_IDS } from "../src/view.ts";

function makeState(): AppState {
  resetToastIdForTest();
  return initialState({
    config: {} as AppState["config"],
    configPath: "/home/.foreman/config.json",
    repoAlias: "demo",
    team: "ENG",
    viewIds: VIEW_IDS,
    now: 1000,
  });
}

function makeHandle(id: LoopId, overrides: Partial<LoopHandle> = {}): LoopHandle {
  return {
    id,
    kind: id === "intake" ? "intake" : "repo",
    label: id === "intake" ? "intake" : "demo",
    alias: id === "intake" ? null : "demo",
    repoPath: id === "intake" ? null : "/repo",
    paths: {
      dir: "/state",
      lock: "/state/loop.lock",
      bookkeeping: "/state/bookkeeping.json",
      status: "/state/status.json",
      socket: "/state/control.sock",
      log: "/state/loop.log",
    },
    running: false,
    pid: null,
    startedAt: null,
    reachable: false,
    status: null,
    staleStatus: false,
    ...overrides,
  } as LoopHandle;
}

function makeSnapshot(): LoopSnapshot {
  return { loop: { id: "repo:demo" } } as unknown as LoopSnapshot;
}

describe("reduce — purity", () => {
  it("returns a new object and leaves the input untouched", () => {
    const state = makeState();
    const next = reduce(state, { type: "clock", now: 2000 });
    expect(next).not.toBe(state);
    expect(state.now).toBe(1000);
    expect(next.now).toBe(2000);
  });
});

describe("reduce — moveCursor", () => {
  it("clamps at the lower bound", () => {
    const state = makeState();
    const next = reduce(state, { type: "moveCursor", view: "agents", delta: -5, max: 10 });
    expect(next.cursor.agents).toBe(0);
  });

  it("clamps at the upper bound", () => {
    const state = makeState();
    const next = reduce(state, { type: "moveCursor", view: "agents", delta: 50, max: 10 });
    expect(next.cursor.agents).toBe(10);
  });
});

describe("reduce — cycleLoop", () => {
  it("wraps back to the first loop", () => {
    let state = makeState();
    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo"), makeHandle("intake")] });
    state = reduce(state, { type: "focusLoop", index: 1 });
    expect(state.focusedLoop).toBe(1);
    state = reduce(state, { type: "cycleLoop" });
    expect(state.focusedLoop).toBe(0);
  });
});

describe("reduce — clock and toasts", () => {
  it("expires toasts past 4000ms and keeps fresh ones", () => {
    let state = makeState();
    state = reduce(state, { type: "toast", kind: "ok", message: "old" });
    state = reduce(state, { type: "clock", now: 5001 });
    state = reduce(state, { type: "toast", kind: "ok", message: "fresh" });
    state = reduce(state, { type: "clock", now: 5500 });
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.message).toBe("fresh");
  });
});

describe("reduce — logs", () => {
  it("caps at 2000 lines and preserves arrival order", () => {
    let state = makeState();
    const lines = Array.from({ length: 2500 }, (_, i) => ({
      seq: i,
      at: "2026-01-01T00:00:00.000Z",
      level: "info" as const,
      loopId: "repo:demo" as LoopId,
      line: `line-${i}`,
    }));
    state = reduce(state, { type: "log", lines });
    expect(state.logs).toHaveLength(2000);
    expect(state.logs[0]?.line).toBe("line-500");
    expect(state.logs[state.logs.length - 1]?.line).toBe("line-2499");
  });
});

describe("reduce — loops", () => {
  it("merges handles while preserving an existing snapshot", () => {
    let state = makeState();
    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo")] });
    const snapshot = makeSnapshot();
    state = reduce(state, { type: "snapshot", loopId: "repo:demo", snapshot });
    state = reduce(state, {
      type: "loops",
      handles: [makeHandle("repo:demo", { running: true, pid: 42 })],
    });
    expect(state.loops[0]?.snapshot).toBe(snapshot);
    expect(state.loops[0]?.handle.running).toBe(true);
  });

  /*
   * Regression: `Session` polls each loop's handle on its own timer and
   * dispatches that single handle. When this case replaced the array instead
   * of upserting, each poll deleted the other pane and the next poll
   * re-created it at `connecting` — the two loops alternately lost their
   * snapshot, and the connection badge flickered live/connecting forever.
   */
  it("leaves loops absent from a partial poll untouched", () => {
    let state = makeState();
    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo"), makeHandle("intake")] });
    const repoSnapshot = makeSnapshot();
    const intakeSnapshot = makeSnapshot();
    state = reduce(state, { type: "snapshot", loopId: "repo:demo", snapshot: repoSnapshot });
    state = reduce(state, { type: "snapshot", loopId: "intake", snapshot: intakeSnapshot });

    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo", { running: true, pid: 7 })] });

    expect(state.loops.map((pane) => pane.id)).toEqual(["repo:demo", "intake"]);
    expect(state.loops[1]?.snapshot).toBe(intakeSnapshot);
    expect(state.loops[1]?.connection).toBe("live");
    expect(state.loops[0]?.connection).toBe("live");
  });

  it("appends a loop it has not seen before", () => {
    let state = makeState();
    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo")] });
    state = reduce(state, { type: "loops", handles: [makeHandle("intake")] });
    expect(state.loops.map((pane) => pane.id)).toEqual(["repo:demo", "intake"]);
  });
});

describe("reduce — snapshot", () => {
  it("promotes a connecting pane to live", () => {
    let state = makeState();
    state = reduce(state, { type: "loops", handles: [makeHandle("repo:demo")] });
    expect(state.loops[0]?.connection).toBe("connecting");
    state = reduce(state, { type: "snapshot", loopId: "repo:demo", snapshot: makeSnapshot() });
    expect(state.loops[0]?.connection).toBe("live");
  });
});

describe("reduce — settingsEdits", () => {
  it("round-trips edit and clear", () => {
    let state = makeState();
    state = reduce(state, { type: "editSetting", key: "loop.wipGlobal", value: 5 });
    expect(state.settingsEdits["loop.wipGlobal"]).toBe(5);
    state = reduce(state, { type: "settingsError", message: "bad value" });
    expect(state.settingsError).toBe("bad value");
    state = reduce(state, { type: "clearSettingEdits" });
    expect(state.settingsEdits).toEqual({});
    expect(state.settingsError).toBeNull();
  });
});
