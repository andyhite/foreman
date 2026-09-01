/**
 * The board (contract §Views/pipeline.ts).
 *
 * `snapshot.board` gives coarse column depth (how backed up is Backlog vs.
 * In Review); `snapshot.queues.pipeline` gives the actual ready-to-work
 * queue. Neither is a substitute for Linear itself — this view exists so
 * the operator can spot a stuck column without leaving the terminal, not to
 * replace the Linear UI.
 */
import type { BoardCounts, Canvas, Column, Key, QueueItem, Rect } from "@foreman/core";
import { gauge, matchesKey, panel, table, truncate } from "@foreman/core";
import { cursorFor, focusedPane } from "../store.ts";
import { priorityGlyph, relativeTime } from "../format.ts";
import type { View, ViewContext } from "../view.ts";
import { displaySnapshot, isFileBacked, paneIdleMessage, staleWatermark } from "../pane.ts";

const VIEW_ID = "pipeline";

function currentFilter(ctx: ViewContext): string {
  return ctx.state.pipelineFilter;
}

function setFilter(ctx: ViewContext, value: string): void {
  ctx.dispatch({ type: "setPipelineFilter", filter: value });
}

function filteredRows(ctx: ViewContext, rows: readonly QueueItem[]): QueueItem[] {
  const filter = currentFilter(ctx).trim().toLowerCase();
  if (!filter) return [...rows];
  return rows.filter((row) => row.issueId.toLowerCase().includes(filter) || row.title.toLowerCase().includes(filter));
}

const COLUMNS: readonly Column<QueueItem>[] = [
  { header: "", width: { fixed: 2 }, render: (row) => priorityGlyph(row.priority) },
  { header: "issue", width: { fixed: 10 }, render: (row) => row.issueId },
  { header: "title", width: { flex: 3, min: 16 }, render: (row) => row.title, },
  { header: "state", width: { fixed: 12 }, render: (row) => row.state },
  { header: "est", width: { fixed: 4 }, render: (row) => (row.estimate === null ? "—" : String(row.estimate)) },
  { header: "labels", width: { flex: 1, min: 10 }, render: (row) => row.labels.join(", ") },
  { header: "updated", width: { fixed: 9 }, render: (row) => "" },
];

const BOARD_COLUMNS: ReadonlyArray<[keyof BoardCounts, string]> = [
  ["backlog", "Backlog"],
  ["todo", "Todo"],
  ["inProgress", "In Progress"],
  ["inReview", "In Review"],
  ["blocked", "Blocked"],
];

export const pipelineView: View = {
  id: VIEW_ID,
  title: "pipeline",

  badge(ctx: ViewContext): string | null {
    const pane = focusedPane(ctx.state);
    const count = pane?.snapshot?.queues.pipeline.length ?? 0;
    return count > 0 ? String(count) : null;
  },

  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const pane = focusedPane(ctx.state);
    if (!pane) {
      canvas.text(rect.x + 1, rect.y + Math.floor(rect.height / 2), "no loop focused", ctx.theme.toneSgr("muted"));
      return;
    }
    const snapshot = displaySnapshot(pane);
    if (!snapshot) {
      const { line1, line2 } = paneIdleMessage(pane);
      const y = rect.y + Math.floor(rect.height / 2);
      canvas.text(rect.x + Math.max(0, Math.floor((rect.width - line1.length) / 2)), y, line1, ctx.theme.toneSgr("muted"));
      if (line2) canvas.text(rect.x + Math.max(0, Math.floor((rect.width - line2.length) / 2)), y + 1, line2, ctx.theme.toneSgr("muted"));
      if (pane.error) canvas.text(rect.x + 1, y + 2, pane.error, ctx.theme.toneSgr("warn"));
      return;
    }

    const stripHeight = 3;
    const stripRect: Rect = { x: rect.x, y: rect.y, width: rect.width, height: stripHeight };
    const tableRect: Rect = { x: rect.x, y: rect.y + stripHeight, width: rect.width, height: rect.height - stripHeight };

    const board = snapshot.board;
    const columnWidth = Math.floor(rect.width / BOARD_COLUMNS.length);
    const maxCount = Math.max(1, ...BOARD_COLUMNS.map(([key]) => board[key]));
    for (const [index, [key, label]] of BOARD_COLUMNS.entries()) {
      const colRect: Rect = { x: stripRect.x + index * columnWidth, y: stripRect.y, width: columnWidth - 1, height: stripHeight };
      canvas.text(colRect.x, colRect.y, truncate(`${label} ${board[key]}`, colRect.width));
      gauge(canvas, { x: colRect.x, y: colRect.y + 1, width: colRect.width, height: 1 }, {
        theme: ctx.theme,
        value: board[key],
        max: maxCount,
      });
    }

    const rows = filteredRows(ctx, snapshot.queues.pipeline);
    const filter = currentFilter(ctx);
    const title = filter ? `pipeline — filter "${filter}"` : "pipeline";
    const inner = panel(canvas, tableRect, {
      theme: ctx.theme,
      title,
      focused: true,
      footer: staleWatermark(pane, ctx.state.now) ?? undefined,
      tone: isFileBacked(pane) ? "warn" : undefined,
    });

    const columns: readonly Column<QueueItem>[] = COLUMNS.map((col) =>
      col.header === "updated" ? { ...col, render: (row: QueueItem) => relativeTime(row.updatedAt, ctx.state.now) } : col,
    );
    const selected = cursorFor(ctx.state, VIEW_ID);
    table(canvas, inner, {
      theme: ctx.theme,
      columns,
      rows,
      selected,
      focused: true,
      emptyMessage: filter ? "no matches" : "pipeline is empty",
    });
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const pane = focusedPane(ctx.state);
    const snapshot = pane ? displaySnapshot(pane) : null;
    if (!snapshot) return false;
    const rows = filteredRows(ctx, snapshot.queues.pipeline);
    const max = rows.length - 1;

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

    const selected = rows[cursorFor(ctx.state, VIEW_ID)];

    if (matchesKey(key, "enter") && selected) {
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "detail",
          title: `${selected.issueId} — ${selected.title}`,
          rows: [
            ["state", selected.state],
            ["priority", String(selected.priority)],
            ["estimate", selected.estimate === null ? "—" : String(selected.estimate)],
            ["labels", selected.labels.join(", ") || "—"],
            ["assignee", selected.assignee ?? "—"],
            ["updated", relativeTime(selected.updatedAt, ctx.state.now)],
            ["url", selected.url],
          ],
        },
      });
      return true;
    }
    if (matchesKey(key, "o") && selected) {
      ctx.openUrl(selected.url);
      return true;
    }
    if (matchesKey(key, "/")) {
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "input",
          title: "Filter pipeline",
          label: "id or title contains",
          value: currentFilter(ctx),
          submit: (value: string) => {
            setFilter(ctx, value);
            return { type: "closeModal" };
          },
        },
      });
      return true;
    }
    if (matchesKey(key, "escape") && currentFilter(ctx)) {
      setFilter(ctx, "");
      return true;
    }
    return false;
  },

  hints(ctx: ViewContext): ReadonlyArray<readonly [string, string]> {
    const hints: Array<readonly [string, string]> = [
      ["↑↓", "select"],
      ["enter", "detail"],
      ["o", "open"],
      ["/", "filter"],
    ];
    if (currentFilter(ctx)) hints.push(["esc", "clear filter"]);
    return hints;
  },
};
