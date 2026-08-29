/**
 * The dispatched-agent inspector (contract §Views/agents.ts).
 *
 * This is the one screen where "what is actually running" and "what does
 * Foreman's bookkeeping say" have to agree, because it is also the escape
 * hatch: `enter` hands the terminal to `herdr agent focus` so the operator
 * can watch or steer the agent directly. Everything here is read from the
 * snapshot only — the loop process owns dispatch state, this view never
 * mutates it except through `ctx.command`.
 */
import type { AgentView, Canvas, Column, Key, Rect, Theme } from "@foreman/core";
import { kvRows, matchesKey, panel, table } from "@foreman/core";
import type { Action } from "../store.ts";
import { cursorFor, focusedPane } from "../store.ts";
import {
  agentStatusTone,
  duration,
  relativeTime,
  shortIso,
  TONE_BY_BADGE,
  truncateMiddle as _truncateMiddle,
} from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "agents";

function stepCursor(ctx: ViewContext, delta: number, max: number): void {
  ctx.dispatch({ type: "moveCursor", view: VIEW_ID, delta, max });
}

function agentLabel(agent: string): string {
  return agent.startsWith("foreman-") ? agent.slice("foreman-".length) : agent;
}

function whereLabel(agent: AgentView): string {
  if (agent.herdr) return agent.herdr.paneId;
  if (agent.pid !== null) return `pid ${agent.pid}`;
  return "—";
}

/*
 * Built per render rather than hoisted to a module constant: `Column.sgr`
 * returns a raw SGR prefix, so the status and TTL columns need the live
 * `Theme` to produce one. A hoisted constant has no theme in scope, and
 * returning a tone *name* there paints the literal text "danger" into the
 * cell instead of colouring it.
 */
function columns(theme: Theme): readonly Column<AgentView>[] {
  return [
    {
      header: "status",
      width: { fixed: 9 },
      render: (row) => row.status,
      sgr: (row) => theme.toneSgr(TONE_BY_BADGE[agentStatusTone(row.status)]),
    },
    { header: "agent", width: { flex: 1, min: 12 }, render: (row) => agentLabel(row.agent) },
    { header: "issue", width: { fixed: 10 }, render: (row) => row.issueId ?? "—" },
    { header: "stage", width: { fixed: 10 }, render: (row) => row.stage },
    { header: "age", width: { fixed: 8 }, render: (row) => duration(row.ageMs) },
    {
      header: "ttl",
      width: { fixed: 14 },
      render: (row) => (row.pastTtl ? "past TTL" : duration(Math.max(0, row.ttlMs - row.ageMs))),
      sgr: (row) => (row.pastTtl ? theme.toneSgr("danger") : undefined),
    },
    { header: "where", width: { fixed: 16 }, render: (row) => whereLabel(row) },
  ];
}

function selectedAgent(ctx: ViewContext, agents: readonly AgentView[]): AgentView | null {
  const index = cursorFor(ctx.state, VIEW_ID);
  return agents[index] ?? null;
}

function findIssueUrl(ctx: ViewContext, issueId: string | null): string | null {
  if (!issueId) return null;
  for (const pane of ctx.state.loops) {
    const item = pane.snapshot?.queues.pipeline.find((row) => row.issueId === issueId);
    if (item) return item.url;
  }
  return null;
}

export const agentsView: View = {
  id: VIEW_ID,
  title: "agents",

  badge(ctx: ViewContext): string | null {
    const pane = focusedPane(ctx.state);
    const count = pane?.snapshot?.agents.length ?? 0;
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

    const agents = snapshot.agents;
    const listWidth = Math.floor(rect.width * 0.6);
    const listRect: Rect = { x: rect.x, y: rect.y, width: listWidth, height: rect.height };
    const detailRect: Rect = { x: rect.x + listWidth, y: rect.y, width: rect.width - listWidth, height: rect.height };

    const listInner = panel(canvas, listRect, { theme: ctx.theme, title: "agents", focused: true });
    const selected = cursorFor(ctx.state, VIEW_ID);
    table(canvas, listInner, {
      theme: ctx.theme,
      columns: columns(ctx.theme),
      rows: agents,
      selected,
      focused: true,
      emptyMessage: "no dispatched agents",
    });

    const detailInner = panel(canvas, detailRect, { theme: ctx.theme, title: "detail", focused: false });
    const agent = selectedAgent(ctx, agents);
    if (!agent) {
      canvas.text(detailInner.x + 1, detailInner.y, "no agent selected", ctx.theme.toneSgr("muted"));
      return;
    }

    const entries: Array<readonly [string, string]> = [
      ["dispatch", agent.dispatchId],
      ["agent", agent.agent],
      ["issue", agent.issueId ?? "—"],
      ["stage", agent.stage],
      ["started", `${shortIso(agent.startedAt)} (${relativeTime(agent.startedAt, ctx.state.now)})`],
      ["age", duration(agent.ageMs)],
      ["status", agent.status],
      [
        "ttl",
        agent.pastTtl ? `${duration(agent.ttlMs)} — past TTL` : duration(Math.max(0, agent.ttlMs - agent.ageMs)),
      ],
      ["herdr pane", agent.herdr?.paneId ?? "—"],
      ["herdr agent", agent.herdr?.agentName ?? "—"],
      ["pid", agent.pid !== null ? String(agent.pid) : "—"],
      ["worktree", agent.worktree ?? "—"],
    ];
    kvRows(canvas, detailInner, { theme: ctx.theme, entries, labelWidth: 12 });

    if (agent.pastTtl) {
      const warnY = detailInner.y + entries.length + 1;
      if (warnY < detailInner.y + detailInner.height) {
        canvas.text(
          detailInner.x,
          warnY,
          _truncateMiddle("past TTL — the reaper will clear this lock", detailInner.width),
          ctx.theme.toneSgr("warn"),
        );
      }
    }
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const pane = focusedPane(ctx.state);
    const snapshot = pane?.snapshot ?? null;
    if (!snapshot) return false;
    const agents = snapshot.agents;
    const max = agents.length;

    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      stepCursor(ctx, -1, max);
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      stepCursor(ctx, 1, max);
      return true;
    }
    if (matchesKey(key, "pageup")) {
      stepCursor(ctx, -10, max);
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      stepCursor(ctx, 10, max);
      return true;
    }
    if (matchesKey(key, "home")) {
      ctx.dispatch({ type: "setCursor", view: VIEW_ID, index: 0 });
      return true;
    }
    if (matchesKey(key, "end")) {
      ctx.dispatch({ type: "setCursor", view: VIEW_ID, index: Math.max(0, max - 1) });
      return true;
    }

    const agent = selectedAgent(ctx, agents);
    if (!agent || !pane) return false;

    if (matchesKey(key, "enter") || matchesKey(key, "a")) {
      const dispatchId = agent.dispatchId;
      const loopId = pane.id;
      ctx.suspend(async () => {
        ctx.command(loopId, "attachAgent", { dispatchId });
      }).catch(() => {
        ctx.toast("danger", "attach failed");
      });
      return true;
    }
    if (matchesKey(key, "x")) {
      // The kill rides on the modal's `effect`, so it fires when the operator
      // answers rather than on the keypress that asks the question.
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "confirm",
          title: `Kill ${agentLabel(agent.agent)}?`,
          body: [`Issue ${agent.issueId ?? "—"} — this ends the dispatched agent process.`],
          confirmLabel: "Kill",
          effect: { loopId: pane.id, op: "killAgent", params: { dispatchId: agent.dispatchId } },
        },
      });
      return true;
    }
    if (matchesKey(key, "o")) {
      const url = findIssueUrl(ctx, agent.issueId);
      if (url) {
        ctx.openUrl(url);
      } else {
        ctx.toast("warn", "issue url unknown");
      }
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [
      ["↑↓", "select"],
      ["enter", "attach"],
      ["x", "kill"],
      ["o", "open"],
    ];
  },
};
