/**
 * Merged event stream (contract §Views/logs.ts).
 *
 * Logs arrive over the control socket per loop and get merged in the store;
 * this view is the tail of that merge, filtered to the active scope because
 * interleaved logs from two loops are rarely useful to read together.
 */
import type { Canvas, Key, Rect } from "@foreman/core";
import type { LogViewLine } from "@foreman/core";
import { logView, matchesKey, panel } from "@foreman/core";
import { focusedPane } from "../store.ts";
import { shortIso } from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "logs";


function toneFor(level: "info" | "warn" | "error"): "danger" | "warn" | undefined {
  if (level === "error") return "danger";
  if (level === "warn") return "warn";
  return undefined;
}

interface WindowedLogs {
  lines: LogViewLine[];
  scroll: number;
}

/** Filters and windows the raw log buffer to the visible rows before mapping
 * any of it into styled segments — the segment mapping allocates a theme
 * lookup per line, which is wasted work for every line scrolled out of view. */
function windowedLines(ctx: ViewContext, focusedLoopId: string | null, height: number, storedScroll: number): WindowedLogs {
  const needle = ctx.state.logFilter.toLowerCase();
  const filtered = ctx.state.logs.filter((line) => {
    if (line.loopId !== focusedLoopId) return false;
    if (needle && !line.line.toLowerCase().includes(needle)) return false;
    return true;
  });
  const visible = Math.max(0, height);
  const maxScroll = Math.max(0, filtered.length - visible);
  const scroll = ctx.state.logFollow ? maxScroll : Math.min(Math.max(storedScroll, 0), maxScroll);
  const lines = filtered.slice(scroll, scroll + visible).map((line) => {
    const tone = toneFor(line.level);
    const segments: LogViewLine = [
      { text: shortIso(line.at), sgr: ctx.theme.toneSgr("muted") },
      { text: " " },
      { text: line.level.padEnd(5), sgr: tone ? ctx.theme.toneSgr(tone) : "" },
      { text: " " },
      { text: line.line },
    ];
    return segments;
  });
  return { lines, scroll };
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
    const title = `logs — ${pane?.label ?? "—"}`;
    const followLabel = ctx.state.logFollow ? "following" : "pinned";
    const filterLabel = ctx.state.logFilter ? ` · /${ctx.state.logFilter}` : "";
    const inner = panel(canvas, rect, {
      theme: ctx.theme,
      title,
      focused: true,
      footer: `${followLabel}${filterLabel}`,
    });
    const scrollKey = VIEW_ID;
    const stored = ctx.state.scroll[scrollKey] ?? 0;
    const { lines, scroll } = windowedLines(ctx, pane?.id ?? null, inner.height, stored);
    logView(canvas, inner, { theme: ctx.theme, lines, scroll: 0, follow: ctx.state.logFollow });
    if (scroll !== stored) ctx.dispatch({ type: "setScroll", view: scrollKey, scroll });
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const scrollKey = VIEW_ID;
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
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: scrollKey, scroll: (ctx.state.scroll[scrollKey] ?? 0) - 1 });
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: scrollKey, scroll: (ctx.state.scroll[scrollKey] ?? 0) + 1 });
      return true;
    }
    if (matchesKey(key, "pageup")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: scrollKey, scroll: (ctx.state.scroll[scrollKey] ?? 0) - 10 });
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: scrollKey, scroll: (ctx.state.scroll[scrollKey] ?? 0) + 10 });
      return true;
    }
    if (matchesKey(key, "home")) {
      ctx.dispatch({ type: "setLogFollow", follow: false });
      ctx.dispatch({ type: "setScroll", view: scrollKey, scroll: 0 });
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
    ];
  },
};
