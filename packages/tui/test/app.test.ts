/**
 * `TuiHost`'s global key bindings are the only place an operator can
 * start, stop, pause, or resume a loop from inside the TUI — `s`/`S`/`p`
 * dispatch through `Session.ensureRunning`/`Session.send`, never through a
 * view. Nothing exercised that wiring before this file: a regression here
 * (e.g. `s` firing on the wrong pane, or `S` skipping its confirm modal)
 * would only ever surface by hand, in a real terminal.
 */

import { describe, expect, it } from "bun:test";
import { createTheme } from "@foreman/core";
import type { ControlOp, LoopId } from "@foreman/core";
import { TuiHost } from "../src/app.ts";
import type { Session } from "../src/session.ts";
import { key, makeLiveState } from "./fixtures.ts";

/** Records every `ensureRunning`/`send` call instead of touching a real socket or process. */
function makeFakeSession(): { session: Session; calls: string[] } {
  const calls: string[] = [];
  const fake = {
    async ensureRunning(id: LoopId): Promise<void> {
      calls.push(`ensureRunning:${id}`);
    },
    async send(id: LoopId, op: ControlOp, params?: Record<string, unknown>): Promise<boolean> {
      calls.push(`send:${id}:${op}:${JSON.stringify(params ?? null)}`);
      return true;
    },
  };
  return { session: fake as unknown as Session, calls };
}

function makeHost(session: Session) {
  const state = makeLiveState();
  return new TuiHost({
    state,
    views: [],
    theme: createTheme(false),
    session,
    suspend: async (fn) => fn(),
    requestRender: () => {},
    quit: () => {},
  });
}

// Flushes the microtask queue so the `void (async () => {...})()` inside
// `#handleModalKey`'s confirm branch resolves before assertions run.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TuiHost — start/stop/pause the focused loop", () => {
  it("s starts the focused loop via Session.ensureRunning", () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("s"));

    expect(calls).toEqual(["ensureRunning:repo:demo"]);
  });

  it("S opens a confirm modal naming the focused loop, without sending stop yet", () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("S"));

    expect(calls).toEqual([]);
    const modal = host.state.modal;
    expect(modal?.kind).toBe("confirm");
    if (modal?.kind !== "confirm") throw new Error("expected confirm modal");
    expect(modal.title).toContain("demo");
    expect(modal.effect).toEqual({ loopId: "repo:demo", op: "stop", params: { mode: "graceful" } });
  });

  it("S then y sends a graceful stop for the focused loop and closes the modal", async () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("S"));
    host.handleKey(key("y"));
    await flush();

    expect(calls).toEqual(['send:repo:demo:stop:{"mode":"graceful"}']);
    expect(host.state.modal).toBeNull();
  });

  it("S then n cancels without sending stop", async () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("S"));
    host.handleKey(key("n"));
    await flush();

    expect(calls).toEqual([]);
    expect(host.state.modal).toBeNull();
  });

  it("p sends pause when the focused loop is running", () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("p"));

    expect(calls).toEqual(["send:repo:demo:pause:null"]);
  });

  it("p sends resume when the focused loop is paused", () => {
    const { session, calls } = makeFakeSession();
    const state = makeLiveState();
    const pane = state.loops[0]!;
    const pausedState = {
      ...state,
      loops: [
        { ...pane, snapshot: pane.snapshot ? { ...pane.snapshot, runtime: { ...pane.snapshot.runtime, state: "paused" as const } } : null },
        ...state.loops.slice(1),
      ],
    };
    const host = new TuiHost({
      state: pausedState,
      views: [],
      theme: createTheme(false),
      session,
      suspend: async (fn) => fn(),
      requestRender: () => {},
      quit: () => {},
    });

    host.handleKey(key("p"));

    expect(calls).toEqual(["send:repo:demo:resume:null"]);
  });

  it("t ticks the focused loop", () => {
    const { session, calls } = makeFakeSession();
    const host = makeHost(session);

    host.handleKey(key("t"));

    expect(calls).toEqual(["send:repo:demo:tick:null"]);
  });
});

