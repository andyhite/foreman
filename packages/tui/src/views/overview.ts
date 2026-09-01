/**
 * `overview` — the landing view and the answer to "what is my active loop
 * doing right now."
 *
 * Scope is selected in the chrome, not inferred from this view. Keeping the
 * overview inside that same scope means its dense worker table can use the
 * whole body instead of making two loops compete for a few visible rows.
 */

import type { AgentView, Canvas, LoopSnapshot, Rect } from "@foreman/core";
import { gauge, matchesKey, panel, sparkline, splitVertical, table } from "@foreman/core";
import { countdown, duration, relativeTime } from "../format.ts";
import { listDetailLayout } from "../layout.ts";
import { displaySnapshot, paneIdleMessage, staleWatermark } from "../pane.ts";
import type { LoopPane } from "../store.ts";
import { cursorFor, focusedPane } from "../store.ts";
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

/**
 * Places complete facts on successive lines rather than relying on Canvas
 * clipping. At normal widths this is one line; when the terminal narrows, a
 * worker's effective stage remains legible instead of the rightmost stages
 * silently disappearing.
 */
function packLines(parts: readonly string[], width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const next = line ? `${line} · ${part}` : part;
    if (line && next.length > width) {
      lines.push(line);
      line = part;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function boardLines(board: LoopSnapshot["board"], ctx: ViewContext, width: number): string[] {
  return packLines(
    [
      `backlog ${board.backlog}`,
      `todo ${board.todo}`,
      `in-progress ${board.inProgress}`,
      `in-review ${board.inReview}`,
      `blocked ${board.blocked}`,
      `proposals ${board.proposals}`,
      `ready ${board.readyBuffer}/${ctx.state.config.loop?.readyBufferTarget ?? "?"}`,
      `triage ${board.triageInbox}`,
    ],
    width,
  );
}

function renderPane(canvas: Canvas, rect: Rect, pane: LoopPane, ctx: ViewContext): void {
  const theme = ctx.theme;
  const inner = panel(canvas, rect, {
    theme,
    title: pane.label,
    subtitle: pane.kind === "intake" ? "team-wide Triage inbox" : undefined,
    focused: true,
  });
  if (inner.width <= 0 || inner.height <= 0) return;

  const snapshot = displaySnapshot(pane);
  if (!snapshot) {
    const { line1, line2 } = paneIdleMessage(pane);
    const y = inner.y + Math.floor(inner.height / 2);
    canvas.text(inner.x + 1, y, line1, theme.toneSgr("muted"));
    if (line2 && y + 1 < inner.y + inner.height) canvas.text(inner.x + 1, y + 1, line2, theme.toneSgr("muted"));
    return;
  }

  const { runtime } = snapshot;
  const workerStages =
    pane.kind === "repo"
      ? ["plan", "refine", "implement", "review"].map(
          (worker) =>
            `${worker} ${ctx.state.config.loop.workerStages[worker as keyof typeof ctx.state.config.loop.workerStages] ?? runtime.stage}`,
        )
      : [runtime.stage];
  const statusLines = [
    ...packLines([runtime.state, ...workerStages, `fallback ${runtime.stage}`, runtime.dispatcher], inner.width),
    ...packLines(
      [
        `pid ${snapshot.loop.pid}`,
        `uptime ${duration(runtime.uptimeMs)}`,
        `ticks ${runtime.ticks}`,
        `next ${countdown(runtime.nextTickAt, ctx.state.now)}`,
        /*
         * `stale` plus its age survives the narrowest status line where
         * `status.json 2m old` becomes a meaningless filename fragment.
         */
        pane.connection === "file" ? `stale ${relativeTime(runtime.lastTickAt, ctx.state.now)}` : pane.connection,
      ],
      inner.width,
    ),
  ];
  const watermark = staleWatermark(pane, ctx.state.now);
  const showBoard = inner.width >= 36;
  const stackedMetrics = inner.width < 100;
  const boardWidth = stackedMetrics ? inner.width : Math.floor((inner.width * 2) / 5);
  const compactBoardLines = showBoard ? boardLines(snapshot.board, ctx, boardWidth) : [];
  const wipRows = 1 + snapshot.wip.byStage.length;
  const metricHeight = stackedMetrics ? wipRows + compactBoardLines.length : Math.max(wipRows, compactBoardLines.length);
  const showSpark = inner.width >= 110;
  const rows = splitVertical(inner, [
    { fixed: statusLines.length + (watermark ? 1 : 0) },
    { fixed: metricHeight },
    { fixed: showSpark ? 1 : 0 },
    { flex: 1 },
    { fixed: snapshot.backpressure.tripped ? 1 : 0 },
  ]);
  const [statusBlock, metricsBlock, sparkBlock, workerBlock, alertBlock] = rows as [Rect, Rect, Rect, Rect, Rect];

  let statusY = statusBlock.y;
  if (watermark && statusBlock.height > 0) {
    canvas.text(statusBlock.x, statusY, watermark, theme.toneSgr("warn"));
    statusY += 1;
  }
  for (const line of statusLines) {
    if (statusY >= statusBlock.y + statusBlock.height) break;
    canvas.text(statusBlock.x, statusY, line, theme.sgr());
    statusY += 1;
  }

  /*
   * Gauges need five rows while board counts usually need two. Wide terminals
   * put those independent summaries beside one another; below the shared
   * list/detail threshold they stack. The metrics block reserves both stacked
   * heights before splitting, so the board never disappears merely because
   * the gauges happened to claim every fixed row.
   */
  const [wipBlock, boardBlock] = listDetailLayout(
    metricsBlock,
    [{ flex: 3 }, { flex: 2 }],
    [{ fixed: wipRows }, { flex: 1 }],
  );
  /*
   * `listDetailLayout` abuts the two columns, which reads as one run of text
   * when a gauge's `2/3` suffix lands flush against `backlog 12`. The gutter
   * is taken off the gauge column because a gauge is elastic and the counts
   * line is not. Gauges are also capped: past roughly 60 columns a longer bar
   * conveys nothing further about a 0..3 value, and the ink crowds the
   * counts beside it.
   */
  const gaugeWidth = Math.max(1, Math.min(wipBlock.width - 2, 60));
  gauge(canvas, { x: wipBlock.x, y: wipBlock.y, width: gaugeWidth, height: 1 }, {
    theme,
    value: snapshot.wip.global.used,
    max: snapshot.wip.global.cap,
    label: "wip",
  });
  snapshot.wip.byStage.forEach((stage, index) => {
    gauge(canvas, { x: wipBlock.x, y: wipBlock.y + 1 + index, width: gaugeWidth, height: 1 }, {
      theme,
      value: stage.used,
      max: stage.cap,
      label: stage.stage,
    });
  });
  compactBoardLines.forEach((line, index) => {
    if (index < boardBlock.height) canvas.text(boardBlock.x, boardBlock.y + index, line, theme.sgr());
  });

  if (showSpark && sparkBlock.height > 0) {
    const spark = sparkline(snapshot.history.dispatchesPerTick, Math.max(1, sparkBlock.width - 14));
    canvas.text(sparkBlock.x, sparkBlock.y, `dispatch/tick ${spark}`, theme.sgr());
  }

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
    focused: true,
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
    const pane = focusedPane(ctx.state);
    const total = pane ? findAgentsForPane(pane).length : 0;
    return total > 0 ? String(total) : null;
  },

  render(canvas, rect, ctx) {
    const pane = focusedPane(ctx.state);
    if (!pane) {
      canvas.text(rect.x + 1, rect.y + 1, "no loops discovered", ctx.theme.toneSgr("muted"));
      return;
    }
    renderPane(canvas, rect, pane, ctx);
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
