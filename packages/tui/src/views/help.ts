/**
 * The key reference (contract §Views/help.ts).
 *
 * Not a tab: `app.ts` renders this as a modal over whatever view is active,
 * because "what does this key do" needs to be answerable without losing
 * the operator's place. It only ever reads state to render; it consumes no
 * key that would mutate anything.
 */
import type { Canvas, Key, Rect } from "@foreman/core";
import { kvRows, matchesKey, splitHorizontal } from "@foreman/core";
import type { View, ViewContext } from "../view.ts";

const GLOBAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["q", "quit"],
  ["ctrl-c", "quit"],
  ["?", "toggle this help"],
  ["1-7", "jump to view"],
  ["tab", "next view"],
  ["shift-tab", "previous view"],
  ["L", "cycle focused loop"],
  ["r", "refresh snapshot"],
  ["s", "start focused loop"],
  ["S", "stop focused loop"],
  ["p", "pause/resume focused loop"],
  ["t", "tick focused loop now"],
  ["g", "go to top (overview)"],
];

const NAVIGATION_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↑ / k", "move up"],
  ["↓ / j", "move down"],
  ["pageup", "page up"],
  ["pagedown", "page down"],
  ["home", "jump to first"],
  ["end", "jump to last"],
  ["enter", "open detail / edit"],
  ["escape", "close modal / clear"],
];

const PER_VIEW_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["agents: a / enter", "attach to herdr pane"],
  ["agents: x", "kill agent (confirm)"],
  ["agents: o", "open issue in browser"],
  ["pipeline: /", "filter by id or title"],
  ["pipeline: o", "open issue in browser"],
  ["blocks: u / enter", "reply to a block"],
  ["proposals: y", "approve (names /foreman:apply)"],
  ["proposals: n", "reject with a reason"],
  ["logs: f", "toggle follow"],
  ["logs: A", "toggle both loops"],
  ["settings: ctrl-s", "save pending edits"],
  ["settings: esc", "discard pending edits"],
];

export const helpView: View = {
  id: "help",
  title: "help",

  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const columns = splitHorizontal(rect, [{ flex: 1 }, { flex: 1 }, { flex: 1 }]) as [Rect, Rect, Rect];
    const labelWidth = 12;

    canvas.text(columns[0].x, columns[0].y, "global", ctx.theme.toneSgr("accent"));
    kvRows(canvas, { ...columns[0], y: columns[0].y + 1, height: columns[0].height - 1 }, {
      theme: ctx.theme,
      entries: GLOBAL_KEYS,
      labelWidth,
    });

    canvas.text(columns[1].x, columns[1].y, "navigation", ctx.theme.toneSgr("accent"));
    kvRows(canvas, { ...columns[1], y: columns[1].y + 1, height: columns[1].height - 1 }, {
      theme: ctx.theme,
      entries: NAVIGATION_KEYS,
      labelWidth,
    });

    canvas.text(columns[2].x, columns[2].y, "per view", ctx.theme.toneSgr("accent"));
    kvRows(canvas, { ...columns[2], y: columns[2].y + 1, height: columns[2].height - 1 }, {
      theme: ctx.theme,
      entries: PER_VIEW_KEYS,
      labelWidth: 22,
    });

    const footerY = rect.y + rect.height - 1;
    canvas.text(rect.x, footerY, "loops keep running after you quit", ctx.theme.toneSgr("muted"));
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const scrollDelta = matchesKey(key, "up")
      ? -1
      : matchesKey(key, "down")
        ? 1
        : matchesKey(key, "pageup")
          ? -8
          : matchesKey(key, "pagedown")
            ? 8
            : 0;
    if (scrollDelta !== 0) {
      ctx.dispatch({ type: "setScroll", view: "help", scroll: (ctx.state.scroll["help"] ?? 0) + scrollDelta });
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [["?", "close"]];
  },
};
