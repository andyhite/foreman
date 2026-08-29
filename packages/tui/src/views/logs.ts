/**
 * Merged event stream (contract §Views/logs.ts).
 *
 * Logs arrive over the control socket per loop and get merged in the store;
 * this view is the tail of that merge, filtered to the focused loop by
 * default because the two loops' logs interleaved by wall clock are rarely
 * what the operator wants to read together.
 */
import type { Canvas, Key, Rect } from "@foreman/core";
import type { LogViewLine } from "@foreman/core";
import { logView, matchesKey, panel } from "@foreman/core";
import { focusedPane } from "../store.ts";
import { shortIso } from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "logs";

// `ui.logsAllLoops` is view-local UI state, not config: it toggles whether
// this view merges both loops' logs or shows only the focused loop's. It is
// parked in `settingsEdits` alongside `ui.pipelineFilter` for the same
// reason — `settings.ts` skips every `ui.*` key when building a config patch.
const ALL_LOOPS_KEY = "ui.logsAllLoops";

function showAllLoops(ctx: ViewContext): boolean {
  return Boolean(ctx.state.settingsEdits[ALL_LOOPS_KEY]);
}

function toneFor(level: "info" | "warn" | "error"): "danger" | "warn" | undefined {
  if (level === "error") return "danger";
  if (level === "warn") return "warn";
  return undefined;
}

function visibleLines(ctx: ViewContext, focusedLoopId: string | null): LogViewLine[] {
  const all = showAllLoops(ctx);
  const lines = ctx.state.logs.filter((line) => all || line.loopId === focusedLoopId);
  return lines.map((line) => {
    const tone = toneFor(line.level);
    const segments: LogViewLine = [
      { text: shortIso(line.at), sgr: ctx.theme.toneSgr("muted") },
      { text: " " },
      { text: line.level.padEnd(5), sgr: tone ? ctx.theme.toneSgr(tone) : "" },
      { text: " " },
      ...(all ? [{ text: `${line.loopId} `, sgr: ctx.theme.toneSgr("accent") }] : []),
      { text: line.line },
    ];
    return segments;
  });
}

export const logsView: View = {
  id: VIEW_ID,
  title: "logs",

  badge(ctx: ViewContext): string | null {
    const errorCount = ctx.state.logs.slice(-200).filter((line) => line.level === "error").length;
    return errorCount > 0 ? String(errorCount) : null;
  },

  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const pane = focusedPane(ctx.state);
    const lines = visibleLines(ctx, pane?.id ?? null);
    const title = showAllLoops(ctx) ? "logs — both loops" : `logs — ${pane?.label ?? "—"}`;
    const inner = panel(canvas, rect, { theme: ctx.theme, title, focused: true });
    const stored = ctx.state.scroll[VIEW_ID] ?? 0;
    const result = logView(canvas, inner, {
      theme: ctx.theme,
      lines,
      scroll: stored,
      follow: ctx.state.logFollow,
      filter: ctx.state.logFilter || undefined,
    });
    // Clamping is idempotent (same input always clamps to the same
    // output), so this dispatch only fires once per out-of-range scroll —
    // unlike settings' render-time dispatch it cannot oscillate.
    if (result.scroll !== stored) ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: result.scroll });
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    if (matchesKey(key, "f")) {
      ctx.dispatch({ type: "setLogFollow", follow: !ctx.state.logFollow });
      return true;
    }
    if (matchesKey(key, "/")) {
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "input",
          title: "Filter logs",
          label: "contains",
          value: ctx.state.logFilter,
          submit: (value: string) => ({ type: "setLogFilter", filter: value }),
        },
      });
      return true;
    }
    if (matchesKey(key, "escape") && ctx.state.logFilter) {
      ctx.dispatch({ type: "setLogFilter", filter: "" });
      return true;
    }
    if (matchesKey(key, "A")) {
      ctx.dispatch({ type: "editSetting", key: ALL_LOOPS_KEY, value: !showAllLoops(ctx) });
      return true;
    }
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: (ctx.state.scroll[VIEW_ID] ?? 0) - 1 });
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: (ctx.state.scroll[VIEW_ID] ?? 0) + 1 });
      return true;
    }
    if (matchesKey(key, "pageup")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: (ctx.state.scroll[VIEW_ID] ?? 0) - 10 });
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: (ctx.state.scroll[VIEW_ID] ?? 0) + 10 });
      return true;
    }
    if (matchesKey(key, "home")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: VIEW_ID, scroll: 0 });
      return true;
    }
    if (matchesKey(key, "end")) {
      ctx.dispatch({ type: "setLogFollow", follow: true });
      return true;
    }
    return false;
  },

  hints(ctx: ViewContext): ReadonlyArray<readonly [string, string]> {
    return [
      ["f", ctx.state.logFollow ? "unfollow" : "follow"],
      ["/", "filter"],
      ["A", showAllLoops(ctx) ? "this loop" : "both loops"],
    ];
  },
};
