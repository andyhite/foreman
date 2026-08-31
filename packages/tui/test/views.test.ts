/**
 * The view-layer regression guard.
 *
 * `render(canvas, rect, ctx)` is pure and total by contract — `app.ts` calls
 * every view's `render` and `handleKey` once per frame with no try/catch of
 * its own, so a view that throws or silently paints nothing wedges the
 * whole full-screen app, not just its own tab. Nothing in `packages/tui`
 * exercised that contract before this file: two real defects (a tone name
 * painted literally into a cell, and a store reducer that deleted a pane)
 * would both have failed the render-safety and content assertions below.
 */

import { describe, expect, it } from "bun:test";
import { Canvas, createTheme, stripAnsi } from "@foreman/core";
import { TuiHost } from "../src/app.ts";
import type { Rect } from "@foreman/core";
import type { View } from "../src/view.ts";
import { agentsView } from "../src/views/agents.ts";
import { blocksView } from "../src/views/blocks.ts";
import { logsView } from "../src/views/logs.ts";
import { overviewView } from "../src/views/overview.ts";
import { pipelineView } from "../src/views/pipeline.ts";
import { proposalsView } from "../src/views/proposals.ts";
import { settingsView } from "../src/views/settings.ts";
import { key, makeContext, makeLiveState, makeOfflineState } from "./fixtures.ts";

const VIEWS: readonly View[] = [
  overviewView,
  agentsView,
  pipelineView,
  blocksView,
  proposalsView,
  logsView,
  settingsView,
];

const RECTS: readonly Rect[] = [
  { x: 0, y: 0, width: 120, height: 40 },
  { x: 0, y: 0, width: 80, height: 24 },
  { x: 0, y: 0, width: 200, height: 60 },
  { x: 0, y: 0, width: 40, height: 12 },
  { x: 0, y: 0, width: 120, height: 3 },
  { x: 0, y: 0, width: 0, height: 0 },
  { x: 0, y: 0, width: 1, height: 1 },
  { x: 5, y: 2, width: 60, height: 20 },
];

function canvasFor(rect: Rect): Canvas {
  return new Canvas(Math.max(1, rect.x + rect.width), Math.max(1, rect.y + rect.height));
}

describe("views — render safety", () => {
  for (const view of VIEWS) {
    for (const rect of RECTS) {
      it(`${view.id} does not throw at ${rect.width}x${rect.height} (origin ${rect.x},${rect.y}), live`, () => {
        const ctx = makeContext(makeLiveState());
        const canvas = canvasFor(rect);
        expect(() => view.render(canvas, rect, ctx)).not.toThrow();
      });

      it(`${view.id} does not throw at ${rect.width}x${rect.height} (origin ${rect.x},${rect.y}), offline`, () => {
        const ctx = makeContext(makeOfflineState());
        const canvas = canvasFor(rect);
        expect(() => view.render(canvas, rect, ctx)).not.toThrow();
      });
    }
  }
});

describe("views — no style leaks", () => {
  // "warn"/"info"/"muted"/"ok" are excluded: they appear as legitimate copy
  // (log levels, hints, worker state words), not just as leaked tone/badge
  // identifiers. Every other name below has no legitimate reason to reach
  // the screen as a bare word — it can only get there through the same
  // mistake as the `agents.ts` defect this suite guards against: passing a
  // tone/badge *name* somewhere an SGR prefix or a real value was expected.
  const FORBIDDEN = [
    "danger",
    "badgeOk",
    "badgeWarn",
    "badgeDanger",
    "badgeMuted",
    "borderFocus",
    "toneSgr",
    "undefined",
    "NaN",
    "[object Object]",
  ];

  for (const view of VIEWS) {
    it(`${view.id} paints no leaked tone/badge identifiers`, () => {
      const theme = createTheme(true);
      const rect: Rect = { x: 0, y: 0, width: 160, height: 50 };
      const canvas = canvasFor(rect);
      const ctx = makeContext(makeLiveState(), theme);
      view.render(canvas, rect, ctx);
      const text = stripAnsi(canvas.toLines().join("\n"));
      for (const forbidden of FORBIDDEN) {
        const pattern =
          forbidden === "[object Object]" ? forbidden : new RegExp(`\\b${forbidden}\\b`);
        if (typeof pattern === "string") {
          expect(text).not.toContain(pattern);
        } else {
          expect(text).not.toMatch(pattern);
        }
      }
    });
  }
});

const CONTENT_RECT: Rect = { x: 0, y: 0, width: 160, height: 50 };

describe("views — content", () => {
  it("overview shows both loops, run state, stage, pid, wip, board counts, workers, backpressure reason", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    overviewView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    expect(text).toContain("demo");
    expect(text).toContain("intake");
    expect(text).toContain("running");
    expect(text).toContain("full");
    expect(text).toContain("pid 4242");
    expect(text).toContain("2/3");
    expect(text).toContain("backlog 12");
    expect(text).toContain("triage 6");
    for (const worker of ["reaper", "plan", "refine", "implement", "review", "merge-detect", "project-status"]) {
      expect(text).toContain(worker);
    }
    expect(text).toContain("blocked queue depth 5 exceeds threshold 3");
  });

  it("agents shows both dispatch rows, past TTL, herdr pane id, and the selected worktree", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    agentsView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    expect(text).toContain("ENG-201");
    expect(text).toContain("ENG-202");
    expect(text).toContain("past TTL");
    expect(text).toContain("herdr-pane-7");
    expect(text).toContain("/Users/user/Code/acme/demo-worktrees/ENG-201");
  });

  it("pipeline shows every issue id and at least one title", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    pipelineView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    for (const id of ["ENG-601", "ENG-602", "ENG-603", "ENG-604", "ENG-605"]) {
      expect(text).toContain(id);
    }
    expect(text).toContain("Todo item, urgent");
  });

  it("blocks shows both issue ids, the selected question, both options, and the recommendation", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    blocksView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    expect(text).toContain("ENG-301");
    expect(text).toContain("ENG-302");
    expect(text).toContain("Should the retry backoff be linear or exponential once the retry cap is raised?");
    expect(text).toContain("linear");
    expect(text).toContain("exponential");
    expect(text).toContain("recommendation: exponential");
  });

  it("proposals shows every issue id, each destination, and the duplicate target", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    proposalsView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    for (const id of ["ENG-401", "ENG-402", "ENG-403"]) {
      expect(text).toContain(id);
    }
    for (const destination of ["Backlog", "Duplicate", "Canceled"]) {
      expect(text).toContain(destination);
    }
    expect(text).toContain("ENG-105");
  });

  it("logs shows seeded lines, and a non-matching filter hides them all", () => {
    const state = makeLiveState();
    const loop = state.loops[0]!;
    const withLogs = {
      ...state,
      logs: [
        { seq: 1, at: "2026-08-29T00:00:00.000Z", level: "info" as const, loopId: loop.id, line: "starting up" },
        { seq: 2, at: "2026-08-29T00:00:01.000Z", level: "error" as const, loopId: loop.id, line: "widget exploded" },
      ],
    };
    const canvas = canvasFor(CONTENT_RECT);
    logsView.render(canvas, CONTENT_RECT, makeContext(withLogs));
    const shown = stripAnsi(canvas.toLines().join("\n"));
    expect(shown).toContain("starting up");
    expect(shown).toContain("widget exploded");

    const filtered = { ...withLogs, logFilter: "no-such-substring" };
    const filteredCanvas = canvasFor(CONTENT_RECT);
    logsView.render(filteredCanvas, CONTENT_RECT, makeContext(filtered));
    const hidden = stripAnsi(filteredCanvas.toLines().join("\n"));
    expect(hidden).not.toContain("starting up");
    expect(hidden).not.toContain("widget exploded");
  });

  it("overview identifies each worker's effective stage when a worker overrides the fallback", () => {
    const state = makeLiveState();
    const mixedStages = {
      ...state,
      config: {
        ...state.config,
        loop: { ...state.config.loop, stage: "dry-run" as const, workerStages: { plan: "full" as const } },
      },
      loops: state.loops.map((pane) =>
        pane.kind === "repo" && pane.snapshot
          ? { ...pane, snapshot: { ...pane.snapshot, runtime: { ...pane.snapshot.runtime, stage: "dry-run" as const } } }
          : pane,
      ),
    };
    const canvas = canvasFor(CONTENT_RECT);
    overviewView.render(canvas, CONTENT_RECT, makeContext(mixedStages));
    const text = stripAnsi(canvas.toLines().join("\n"));

    expect(text).toContain("plan full");
  });


  it("overview puts plan's effective stage before the global fallback in a narrow pane", () => {
    const state = makeLiveState();
    const mixedStages = {
      ...state,
      config: {
        ...state.config,
        loop: { ...state.config.loop, stage: "dry-run" as const, workerStages: { plan: "full" as const } },
      },
      loops: state.loops.map((pane) =>
        pane.kind === "repo" && pane.snapshot
          ? { ...pane, snapshot: { ...pane.snapshot, runtime: { ...pane.snapshot.runtime, stage: "dry-run" as const } } }
          : pane,
      ),
    };
    const canvas = new Canvas(80, 24);
    overviewView.render(canvas, { x: 0, y: 0, width: 80, height: 24 }, makeContext(mixedStages));

    expect(stripAnsi(canvas.toLines().join("\n"))).toContain("running · plan full");
  });
  it("settings shows section headers, global and worker stages, real config keys with defaults, and the lock ttl", () => {
    const state = makeLiveState();
    const ctx = makeContext(state);
    const canvas = canvasFor(CONTENT_RECT);
    settingsView.render(canvas, CONTENT_RECT, ctx);
    const text = stripAnsi(canvas.toLines().join("\n"));

    for (const section of ["loop", "intake", "agent", "repo defaults"]) {
      expect(text).toContain(section);
    }
    expect(text).toContain(state.config.loop.stage);
    for (const label of ["plan stage", "refine stage", "implement stage", "review stage"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain(state.config.agent.approvalMode);
    expect(text).toContain(state.config.repoDefaults.baseBranch);
    expect(text).toContain(state.configPath);
    const lockTtlMs = 2 * state.config.agent.maxRuntimeMs + state.config.agent.lockTtlMarginMs;
    const hours = Math.floor(lockTtlMs / 3_600_000);
    if (hours > 0) expect(text).toContain(`${hours}h`);
  });

});

  it("footer contains every global hint", () => {
    const canvas = new Canvas(200, 24);
    const host = new TuiHost({
      state: makeLiveState(),
      views: VIEWS,
      theme: createTheme(true),
      session: null as never,
      suspend: async (fn) => fn(),
      requestRender: () => {},
      quit: () => {},
    });
    host.render({ canvas, rect: { x: 0, y: 0, width: 200, height: 24 }, tick: 0 });
    const text = stripAnsi(canvas.toLines().join("\n"));
    for (const label of ["help", "view", "loop", "start", "stop", "pause/resume", "tick", "stage", "quit"]) {
      expect(text).toContain(label);
    }
  });

describe("views — keys", () => {
  const CURSOR_VIEWS: ReadonlyArray<{ view: View; id: string }> = [
    { view: agentsView, id: "agents" },
    { view: pipelineView, id: "pipeline" },
    { view: blocksView, id: "blocks" },
    { view: proposalsView, id: "proposals" },
  ];

  for (const { view, id } of CURSOR_VIEWS) {
    it(`${id}: down/j moves the cursor forward, up/k moves it back`, () => {
      const ctx = makeContext(makeLiveState());
      expect(view.handleKey(key("down"), ctx)).toBe(true);
      expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view: id, delta: 1, max: expect.any(Number) });
      expect(view.handleKey(key("j"), ctx)).toBe(true);
      expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view: id, delta: 1, max: expect.any(Number) });
      expect(view.handleKey(key("up"), ctx)).toBe(true);
      expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view: id, delta: -1, max: expect.any(Number) });
      expect(view.handleKey(key("k"), ctx)).toBe(true);
      expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view: id, delta: -1, max: expect.any(Number) });
    });
  }

  it("overview: down/j and up/k move the focused pane's worker cursor", () => {
    const ctx = makeContext(makeLiveState());
    const pane = ctx.state.loops[0]!;
    const view = `overview:${pane.id}`;
    expect(overviewView.handleKey(key("down"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view, delta: 1, max: expect.any(Number) });
    expect(overviewView.handleKey(key("j"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view, delta: 1, max: expect.any(Number) });
    expect(overviewView.handleKey(key("up"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view, delta: -1, max: expect.any(Number) });
    expect(overviewView.handleKey(key("k"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "moveCursor", view, delta: -1, max: expect.any(Number) });
  });

  it("settings: down/j and up/k select the next or previous field", () => {
    const ctx = makeContext(makeLiveState());
    expect(settingsView.handleKey(key("down"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "setCursor", view: "settings", index: 1 });
    expect(settingsView.handleKey(key("j"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "setCursor", view: "settings", index: 2 });
    expect(settingsView.handleKey(key("up"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "setCursor", view: "settings", index: 1 });
    expect(settingsView.handleKey(key("k"), ctx)).toBe(true);
    expect(ctx.actions.at(-1)).toEqual({ type: "setCursor", view: "settings", index: 0 });
  });

  it("agents: enter attaches through suspend/command, x opens a confirm modal", () => {
    const enterCtx = makeContext(makeLiveState());
    expect(agentsView.handleKey(key("enter"), enterCtx)).toBe(true);
    expect(enterCtx.calls).toContain("suspend");
    expect(enterCtx.calls.some((call) => call.includes("attachAgent"))).toBe(true);

    /*
     * `x` must only *ask*. The mutation rides on the modal's `effect`, which
     * `app.ts#handleModalKey` runs when the operator answers `y`/`enter` —
     * this used to fire `killAgent` on the same keystroke that opened the
     * modal, which made every confirm in the app decorative.
     */
    const killCtx = makeContext(makeLiveState());
    expect(agentsView.handleKey(key("x"), killCtx)).toBe(true);
    const modal = killCtx.state.modal;
    expect(modal?.kind).toBe("confirm");
    expect(killCtx.calls.some((call) => call.includes("killAgent"))).toBe(false);
    if (modal?.kind !== "confirm") throw new Error("expected a confirm modal");
    expect(modal.effect?.op).toBe("killAgent");
    expect(modal.effect?.params).toEqual({ dispatchId: "dispatch-1" });
  });

  it("settings: ctrl-s with a pending edit opens a confirm modal", () => {
    const ctx = makeContext(makeLiveState());
    ctx.dispatch({ type: "editSetting", key: "loop.wipGlobal", value: 5 });
    expect(settingsView.handleKey(key("ctrl-s"), ctx)).toBe(true);
    expect(ctx.state.modal?.kind).toBe("confirm");
  });

  it("settings: an unset worker stage displays the global fallback and saves through patchConfig", () => {
    const ctx = makeContext(makeLiveState());
    ctx.dispatch({ type: "setCursor", view: "settings", index: 1 });

    expect(settingsView.handleKey(key("enter"), ctx)).toBe(true);
    expect(ctx.state.settingsEdits["ui.editingPath"]).toBe("loop.workerStages.plan");
    // The fixture has no plan override and defaults to global `dry-run`;
    // right must therefore select `read-only`, not advance from an undefined value.
    expect(settingsView.handleKey(key("right"), ctx)).toBe(true);
    expect(settingsView.handleKey(key("enter"), ctx)).toBe(true);
    expect(ctx.state.settingsEdits["loop.workerStages.plan"]).toBe("read-only");

    expect(settingsView.handleKey(key("ctrl-s"), ctx)).toBe(true);
    const modal = ctx.state.modal;
    if (modal?.kind !== "confirm") throw new Error("expected a save confirmation");
    expect(modal.effect).toEqual({
      loopId: "repo:demo",
      op: "patchConfig",
      params: { patch: { loop: { workerStages: { plan: "read-only" } } } },
    });
  });

  it("settings: committing an invalid value dispatches settingsError, not editSetting", () => {
    const ctx = makeContext(makeLiveState());
    // `intake.window` is the one field settings.ts validates itself (a
    // number field cannot reach `handleKey`'s commit branch out of range —
    // `applyFieldKey` clamps every number commit to its `min` before
    // `validate()` ever runs, so that branch of `validate()` is unreachable
    // through the UI and is not exercised here).
    const index = 16; // intake.window — see SECTIONS in settings.ts
    ctx.dispatch({ type: "setCursor", view: "settings", index });
    expect(settingsView.handleKey(key("enter"), ctx)).toBe(true);
    expect(ctx.state.settingsEdits["ui.editingPath"]).toBe("intake.window");
    for (const ch of "not-a-time") {
      settingsView.handleKey(key(ch), ctx);
    }
    const before = ctx.actions.length;
    expect(settingsView.handleKey(key("enter"), ctx)).toBe(true);
    const dispatched = ctx.actions.slice(before);
    expect(dispatched.some((action) => action.type === "settingsError" && action.message)).toBe(true);
    expect(dispatched.some((action) => action.type === "editSetting" && action.key === "intake.window")).toBe(false);
  });

  it("settings: cancelling an edit clears editingPath entirely, so global keys are no longer swallowed", () => {
    const ctx = makeContext(makeLiveState());
    expect(settingsView.handleKey(key("enter"), ctx)).toBe(true);
    expect(ctx.state.settingsEdits["ui.editingPath"]).toBeDefined();
    expect(settingsView.handleKey(key("escape"), ctx)).toBe(true);
    // The store's `EDITING_PATH_KEY` entry must be gone, not set to "" —
    // an empty string used to still read as "still editing" and every
    // subsequent keypress (tab, q, ctrl-c) was consumed here forever.
    expect("ui.editingPath" in ctx.state.settingsEdits).toBe(false);
    expect(settingsView.handleKey(key("q"), ctx)).toBe(false);
  });

  for (const { view, id } of [
    { view: overviewView, id: "overview" },
    ...CURSOR_VIEWS,
    { view: logsView, id: "logs" },
    { view: settingsView, id: "settings" },
  ]) {
    it(`${id}: an unbound key returns false`, () => {
      const ctx = makeContext(makeLiveState());
      expect(view.handleKey(key("z"), ctx)).toBe(false);
    });

    it(`${id}: handleKey never returns a promise`, () => {
      const ctx = makeContext(makeLiveState());
      const result = view.handleKey(key("down"), ctx);
      expect(typeof result).toBe("boolean");
    });
  }
});
