/**
 * The interrupt queue (contract §Views/blocks.ts).
 *
 * Every row here is a worker that stopped and asked a human a question. The
 * loop process has no write path back to Linear for an operator's answer —
 * that happens through `/foreman:unblock <ISSUE>` in an omp session — so
 * this view's job is to make the question and the tradeoffs legible, and to
 * name the exact command that applies the answer. It must never pretend to
 * apply the answer itself.
 */
import type { BlockedItem, Canvas, Column, Key, Rect } from "@foreman/core";
import { matchesKey, panel, splitHorizontal, table, truncate, wrapText } from "@foreman/core";
import { cursorFor, focusedPane } from "../store.ts";
import { relativeTime } from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "blocks";

const COLUMNS: readonly Column<BlockedItem>[] = [
  { header: "type", width: { fixed: 10 }, render: (row) => row.type },
  { header: "issue", width: { fixed: 10 }, render: (row) => row.issueId },
  { header: "question", width: { flex: 1, min: 20 }, render: (row) => truncate(row.question, 200) },
  { header: "detected", width: { fixed: 9 }, render: () => "" },
];

function selectedBlock(ctx: ViewContext, items: readonly BlockedItem[]): BlockedItem | null {
  return items[cursorFor(ctx.state, VIEW_ID)] ?? null;
}

export const blocksView: View = {
  id: VIEW_ID,
  title: "blocks",

  badge(ctx: ViewContext): string | null {
    const pane = focusedPane(ctx.state);
    const count = pane?.snapshot?.queues.blocked.length ?? 0;
    return count > 0 ? String(count) : null;
  },

  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const pane = focusedPane(ctx.state);
    const snapshot = pane?.snapshot ?? null;
    if (!snapshot) {
      const message = pane ? "loop not running — press s to start" : "no snapshot yet";
      canvas.text(
        rect.x + Math.max(0, Math.floor((rect.width - message.length) / 2)),
        rect.y + Math.floor(rect.height / 2),
        message,
        ctx.theme.toneSgr("muted"),
      );
      return;
    }

    const items = snapshot.queues.blocked;
    const [listRect, detailRect] = splitHorizontal(rect, [{ flex: 45 }, { flex: 55 }]) as [Rect, Rect];

    const listInner = panel(canvas, listRect, { theme: ctx.theme, title: "blocked", focused: true });
    const columns: readonly Column<BlockedItem>[] = COLUMNS.map((col) =>
      col.header === "detected" ? { ...col, render: (row: BlockedItem) => relativeTime(row.detectedAt, ctx.state.now) } : col,
    );
    const selected = cursorFor(ctx.state, VIEW_ID);
    table(canvas, listInner, {
      theme: ctx.theme,
      columns,
      rows: items,
      selected,
      focused: true,
      emptyMessage: "nothing blocked",
    });

    const detailInner = panel(canvas, detailRect, { theme: ctx.theme, title: "detail", focused: false });
    const item = selectedBlock(ctx, items);
    if (!item) {
      canvas.text(detailInner.x + 1, detailInner.y, "no block selected", ctx.theme.toneSgr("muted"));
      return;
    }

    let y = detailInner.y;
    const width = detailInner.width;
    canvas.text(detailInner.x, y, truncate(`${item.issueId} — ${item.title}`, width), ctx.theme.sgr("bold"));
    y += 2;

    canvas.text(detailInner.x, y, "what I need", ctx.theme.toneSgr("accent"));
    y += 1;
    for (const line of wrapText(item.question, width)) {
      if (y >= detailInner.y + detailInner.height) break;
      canvas.text(detailInner.x, y, line);
      y += 1;
    }
    y += 1;

    if (item.options.length > 0 && y < detailInner.y + detailInner.height) {
      canvas.text(detailInner.x, y, "options", ctx.theme.toneSgr("accent"));
      y += 1;
      for (const [index, option] of item.options.entries()) {
        if (y >= detailInner.y + detailInner.height) break;
        canvas.text(detailInner.x, y, truncate(`${index + 1}. ${option.label}`, width));
        y += 1;
        if (y >= detailInner.y + detailInner.height) break;
        canvas.text(detailInner.x + 3, y, truncate(option.tradeoff, width - 3), ctx.theme.toneSgr("muted"));
        y += 1;
      }
      y += 1;
    }

    if (item.recommendation && y < detailInner.y + detailInner.height) {
      canvas.text(detailInner.x, y, truncate(`recommendation: ${item.recommendation}`, width), ctx.theme.toneSgr("ok"));
      y += 2;
    }

    const footerY = detailInner.y + detailInner.height - 1;
    if (footerY > y) {
      canvas.text(
        detailInner.x,
        footerY,
        truncate(`replies apply through /foreman:unblock ${item.issueId} in an omp session`, width),
        ctx.theme.toneSgr("muted"),
      );
    }
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const pane = focusedPane(ctx.state);
    const snapshot = pane?.snapshot ?? null;
    if (!snapshot) return false;
    const items = snapshot.queues.blocked;
    const max = items.length - 1;

    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      ctx.dispatch({ type: "moveCursor", view: VIEW_ID, delta: -1, max });
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      ctx.dispatch({ type: "moveCursor", view: VIEW_ID, delta: 1, max });
      return true;
    }
    if (matchesKey(key, "pageup")) {
      ctx.dispatch({ type: "moveCursor", view: VIEW_ID, delta: -10, max });
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      ctx.dispatch({ type: "moveCursor", view: VIEW_ID, delta: 10, max });
      return true;
    }
    if (matchesKey(key, "home")) {
      ctx.dispatch({ type: "setCursor", view: VIEW_ID, index: 0 });
      return true;
    }
    if (matchesKey(key, "end")) {
      ctx.dispatch({ type: "setCursor", view: VIEW_ID, index: Math.max(0, max) });
      return true;
    }

    const item = selectedBlock(ctx, items);
    if ((matchesKey(key, "enter") || matchesKey(key, "u")) && item) {
      const command = `/foreman:unblock ${item.issueId} <reply>`;
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "detail",
          title: `Reply to ${item.issueId}`,
          rows: [["run in an omp session", command]],
          body: ["The TUI does not record or send replies to Linear."],
        },
      });
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [
      ["↑↓", "select"],
      ["enter", "reply"],
    ];
  },
};
