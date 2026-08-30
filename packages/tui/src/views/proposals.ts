/**
 * Staged triage proposals (contract §Views/proposals.ts).
 *
 * The intake loop stages a proposed destination/priority for each inbox
 * item but never applies it unattended — approval is an operator decision
 * made through `/foreman:apply` in an omp session. This view surfaces the
 * queue and names that command; it does not shortcut it.
 */
import type { Canvas, Column, Key, ProposalItem, Rect } from "@foreman/core";
import { kvRows, matchesKey, panel, splitVertical, table, truncate } from "@foreman/core";
import { cursorFor, focusedPane } from "../store.ts";
import { priorityGlyph, priorityLabel, relativeTime } from "../format.ts";
import type { View, ViewContext } from "../view.ts";

const VIEW_ID = "proposals";

const COLUMNS: readonly Column<ProposalItem>[] = [
  { header: "issue", width: { fixed: 10 }, render: (row) => row.issueId },
  { header: "title", width: { flex: 2, min: 16 }, render: (row) => truncate(row.title, 200) },
  { header: "destination", width: { fixed: 14 }, render: (row) => row.destination },
  {
    header: "priority",
    width: { fixed: 12 },
    render: (row) => (row.proposedPriority === null ? "—" : `${priorityGlyph(row.proposedPriority)} ${priorityLabel(row.proposedPriority)}`),
  },
  { header: "dup of", width: { fixed: 10 }, render: (row) => row.duplicateOf ?? "—" },
  { header: "proposed", width: { fixed: 9 }, render: () => "" },
];

function selectedProposal(ctx: ViewContext, items: readonly ProposalItem[]): ProposalItem | null {
  return items[cursorFor(ctx.state, VIEW_ID)] ?? null;
}

export const proposalsView: View = {
  id: VIEW_ID,
  title: "proposals",

  badge(ctx: ViewContext): string | null {
    const pane = focusedPane(ctx.state);
    const count = pane?.snapshot?.queues.proposals.length ?? 0;
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

    const items = snapshot.queues.proposals;
    const [listRect, detailRect] = splitVertical(rect, [{ flex: 70 }, { flex: 30 }]) as [Rect, Rect];

    const listInner = panel(canvas, listRect, {
      theme: ctx.theme,
      title: "proposals",
      focused: true,
      footer: "applies through /foreman:apply <ISSUE> --approve|--reject",
    });
    const columns: readonly Column<ProposalItem>[] = COLUMNS.map((col) =>
      col.header === "proposed" ? { ...col, render: (row: ProposalItem) => relativeTime(row.proposedAt, ctx.state.now) } : col,
    );
    const selected = cursorFor(ctx.state, VIEW_ID);
    table(canvas, listInner, {
      theme: ctx.theme,
      columns,
      rows: items,
      selected,
      focused: true,
      emptyMessage: "no staged proposals",
    });

    const detailInner = panel(canvas, detailRect, { theme: ctx.theme, title: "detail", focused: false });
    const item = selectedProposal(ctx, items);
    if (!item) {
      canvas.text(detailInner.x + 1, detailInner.y, "no proposal selected", ctx.theme.toneSgr("muted"));
      return;
    }
    kvRows(canvas, detailInner, {
      theme: ctx.theme,
      entries: [
        ["issue", item.issueId],
        ["title", item.title],
        ["destination", item.destination],
        ["priority", item.proposedPriority === null ? "—" : priorityLabel(item.proposedPriority)],
        ["duplicate of", item.duplicateOf ?? "—"],
        ["proposed", relativeTime(item.proposedAt, ctx.state.now)],
      ],
      labelWidth: 13,
    });
  },

  handleKey(key: Key, ctx: ViewContext): boolean {
    const pane = focusedPane(ctx.state);
    const snapshot = pane?.snapshot ?? null;
    if (!snapshot) return false;
    const items = snapshot.queues.proposals;
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

    const item = selectedProposal(ctx, items);
    if (!item) return false;

    if (matchesKey(key, "enter")) {
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "detail",
          title: `${item.issueId} — ${item.title}`,
          rows: [
            ["destination", item.destination],
            ["priority", item.proposedPriority === null ? "—" : priorityLabel(item.proposedPriority)],
            ["duplicate of", item.duplicateOf ?? "—"],
            ["proposed", relativeTime(item.proposedAt, ctx.state.now)],
          ],
        },
      });
      return true;
    }
    if (matchesKey(key, "y") || matchesKey(key, "n")) {
      const issueId = item.issueId;
      const flag = matchesKey(key, "y") ? "--approve" : "--reject";
      ctx.dispatch({
        type: "openModal",
        modal: {
          kind: "detail",
          title: `${matchesKey(key, "y") ? "Approve" : "Reject"} ${issueId}`,
          rows: [
            ["destination", item.destination],
            ["run in an omp session", `/foreman:apply ${issueId} ${flag}`],
          ],
          body: ["The TUI does not approve or reject proposals; it only names the command."],
        },
      });
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [
      ["↑↓", "select"],
      ["enter", "detail"],
      ["y", "approve command"],
      ["n", "reject command"],
    ];
  },
};
