/**
 * `overview` — the landing view and the answer to "what is my loop doing
 * right now" for both the repo loop and the intake loop side by side.
 *
 * Every other view acts on one focused loop; this one deliberately never
 * does, because an operator's first question after opening the TUI is
 * always about both processes at once, not whichever happened to be
 * focused last session.
 */

import type { AgentView, Canvas, Rect } from "@foreman/core";
import { BOX, gauge, matchesKey, panel, sparkline, splitHorizontal, splitVertical, table } from "@foreman/core";
import { countdown, duration, relativeTime } from "../format.ts";
import type { LoopPane } from "../store.ts";
import { cursorFor } from "../store.ts";
import type { View, ViewContext } from "../view.ts";

interface WorkerRow {
  name: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  dispatched: number;
  skipped: number;
  errors: number;
  lastSkips: Array<{ issueId: string | null; code: string; message: string }>;
}

function renderPane(canvas: Canvas, rect: Rect, pane: LoopPane, ctx: ViewContext, focused: boolean): void {
  const theme = ctx.theme;
  const inner = panel(canvas, rect, {
    theme,
    title: pane.label,
    subtitle: pane.kind === "intake" ? "team-wide Triage inbox" : undefined,
    focused,
  });
  if (inner.width <= 0 || inner.height <= 0) return;

  const snapshot = pane.snapshot;
  if (!snapshot || pane.connection === "offline") {
    const message = pane.connection === "offline" ? "not running" : "connecting…";
    canvas.text(inner.x + 1, inner.y + Math.floor(inner.height / 2), message, theme.toneSgr("muted"));
    canvas.text(inner.x + 1, inner.y + Math.floor(inner.height / 2) + 1, "press s to start", theme.toneSgr("muted"));
    return;
  }

  const rows = splitVertical(inner, [
    { fixed: 3 },
    { fixed: 2 + snapshot.wip.byStage.length },
    { fixed: 3 },
    { fixed: 2 },
    { flex: 1 },
    { fixed: snapshot.backpressure.tripped ? 1 : 0 },
  ]);
  const [stateBlock, wipBlock, boardBlock, sparkBlock, workerBlock, alertBlock] = rows as [
    Rect,
    Rect,
    Rect,
    Rect,
    Rect,
    Rect,
  ];

  const { runtime } = snapshot;
  const connBadge =
    pane.connection === "file"
      ? `status.json ${relativeTime(snapshot.runtime.lastTickAt, ctx.state.now)} old`
      : pane.connection;
  canvas.text(stateBlock.x, stateBlock.y, `${runtime.state} · ${runtime.stage} · ${runtime.dispatcher}`, theme.sgr());
  canvas.text(
    stateBlock.x,
    stateBlock.y + 1,
    `pid ${snapshot.loop.pid}  uptime ${duration(runtime.uptimeMs)}  ticks ${runtime.ticks}  next ${countdown(runtime.nextTickAt, ctx.state.now)}  ${connBadge}`,
    theme.toneSgr("muted"),
  );

  gauge(canvas, { x: wipBlock.x, y: wipBlock.y, width: wipBlock.width, height: 1 }, {
    theme,
    value: snapshot.wip.global.used,
    max: snapshot.wip.global.cap,
    label: "wip",
  });
  snapshot.wip.byStage.forEach((stage, index) => {
    gauge(canvas, { x: wipBlock.x, y: wipBlock.y + 1 + index, width: wipBlock.width, height: 1 }, {
      theme,
      value: stage.used,
      max: stage.cap,
      label: stage.stage,
    });
  });

  const board = snapshot.board;
  const counts = [
    `backlog ${board.backlog}`,
    `todo ${board.todo}`,
    `in-progress ${board.inProgress}`,
    `in-review ${board.inReview}`,
    `blocked ${board.blocked}`,
    `proposals ${board.proposals}`,
    `ready ${board.readyBuffer}/${ctx.state.config.loop?.readyBufferTarget ?? "?"}`,
    `triage ${board.triageInbox}`,
  ];
  canvas.text(boardBlock.x, boardBlock.y, counts.slice(0, 4).join("  "), theme.sgr());
  canvas.text(boardBlock.x, boardBlock.y + 1, counts.slice(4).join("  "), theme.sgr());

  const spark = sparkline(snapshot.history.dispatchesPerTick, Math.max(1, sparkBlock.width - 14));
  canvas.text(sparkBlock.x, sparkBlock.y, `dispatch/tick ${spark}`, theme.sgr());

  const workerRows: WorkerRow[] = snapshot.workers.map((worker) => ({
    name: worker.name,
    lastRunAt: worker.lastRunAt,
    nextRunAt: worker.nextRunAt,
    dispatched: worker.dispatched,
    skipped: worker.skipped,
    errors: worker.errors,
    lastSkips: worker.lastSkips,
  }));
  const selected = cursorFor(ctx.state, `overview:${pane.id}`);
  table(canvas, workerBlock, {
    theme,
    focused,
    selected,
    columns: [
      { header: "worker", width: { flex: 1, min: 10 }, render: (row) => row.name },
      { header: "last", width: { fixed: 8 }, render: (row) => relativeTime(row.lastRunAt, ctx.state.now) },
      { header: "next", width: { fixed: 8 }, render: (row) => countdown(row.nextRunAt, ctx.state.now) },
      { header: "disp", width: { fixed: 6 }, align: "right", render: (row) => String(row.dispatched) },
      { header: "skip", width: { fixed: 6 }, align: "right", render: (row) => String(row.skipped) },
      {
        header: "err",
        width: { fixed: 6 },
        align: "right",
        render: (row) => String(row.errors),
        sgr: (row) => (row.errors > 0 ? theme.toneSgr("danger") : undefined),
      },
    ],
    rows: workerRows,
  });

  if (snapshot.backpressure.tripped && alertBlock.height > 0) {
    canvas.text(
      alertBlock.x,
      alertBlock.y,
      `backpressure: ${snapshot.backpressure.reason ?? "blocked queue over threshold"}`,
      theme.toneSgr("warn"),
    );
  }
}

function findAgentsForPane(pane: LoopPane): readonly AgentView[] {
  return pane.snapshot?.agents ?? [];
}

export const overviewView: View = {
  id: "overview",
  title: "overview",

  badge(ctx) {
    const total = ctx.state.loops.reduce((sum, pane) => sum + findAgentsForPane(pane).length, 0);
    return total > 0 ? String(total) : null;
  },

  render(canvas, rect, ctx) {
    if (ctx.state.loops.length === 0) {
      canvas.text(rect.x + 1, rect.y + 1, "no loops discovered", ctx.theme.toneSgr("muted"));
      return;
    }
    const columns = splitHorizontal(
      rect,
      ctx.state.loops.map(() => ({ flex: 1 })),
      1,
    );
    ctx.state.loops.forEach((pane, index) => {
      const paneRect = columns[index];
      if (!paneRect) return;
      renderPane(canvas, paneRect, pane, ctx, index === ctx.state.focusedLoop);
    });
    void BOX;
  },

  handleKey(key, ctx) {
    const pane = ctx.state.loops[ctx.state.focusedLoop];
    if (!pane) return false;
    const view = `overview:${pane.id}`;
    const workers = pane.snapshot?.workers ?? [];
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      ctx.dispatch({ type: "moveCursor", view, delta: -1, max: Math.max(0, workers.length - 1) });
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      ctx.dispatch({ type: "moveCursor", view, delta: 1, max: Math.max(0, workers.length - 1) });
      return true;
    }
    if (key.name === "enter") {
      const index = cursorFor(ctx.state, view);
      const worker = workers[index];
      if (worker) {
        ctx.dispatch({
          type: "openModal",
          modal: {
            kind: "detail",
            title: `${worker.name} — last skips`,
            rows: worker.lastSkips.map((skip) => [skip.issueId ?? "—", `${skip.code}: ${skip.message}`] as const),
            body: worker.lastError ? [`error: ${worker.lastError}`] : undefined,
          },
        });
      }
      return true;
    }
    return false;
  },

  hints() {
    return [
      ["↑↓", "worker"],
      ["enter", "skips"],
    ];
  },
};
