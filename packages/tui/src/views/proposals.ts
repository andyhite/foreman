/**
 * Staged triage proposals (contract §Views/proposals.ts).
 *
 * The intake loop stages a proposed destination/priority for each inbox
 * item but never applies it unattended — approval is an operator decision
 * made through `/foreman:apply` in an omp session. This view surfaces the
 * queue and names that command; it does not shortcut it.
 */
import type { Canvas, Column, Key, ProposalItem, Rect } from "@foreman/core";
import { copyToClipboard, kvRows, matchesKey, panel, table, truncate } from "@foreman/core";
import { cursorFor, focusedPane } from "../store.ts";
import { priorityGlyph, priorityLabel, relativeTime } from "../format.ts";
import type { View, ViewContext } from "../view.ts";
import { listDetailLayout } from "../layout.ts";
import { displaySnapshot, isFileBacked, paneIdleMessage, staleWatermark } from "../pane.ts";

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
    const snapshot = pane ? displaySnapshot(pane) : null;
    const count = snapshot?.queues.proposals.length ?? 0;
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

    const items = snapshot.queues.proposals;
    const [listRect, detailRect] = listDetailLayout(rect, [{ flex: 70 }, { flex: 30 }], [{ flex: 60 }, { flex: 40 }]);

    const listInner = panel(canvas, listRect, {
      theme: ctx.theme,
      title: "proposals",
      focused: true,
      footer: staleWatermark(pane, ctx.state.now) ?? "applies through /foreman:apply <ISSUE> --approve|--reject",
      tone: isFileBacked(pane) ? "warn" : undefined,
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
    const snapshot = pane ? displaySnapshot(pane) : null;
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
    if (matchesKey(key, "y")) {
      const command = `/foreman:apply ${item.issueId} --approve`;
      copyToClipboard(command);
      ctx.toast("ok", `copied: ${command}`);
      return true;
    }
    if (matchesKey(key, "n")) {
      const command = `/foreman:apply ${item.issueId} --reject`;
      copyToClipboard(command);
      ctx.toast("ok", `copied: ${command}`);
      return true;
    }
    return false;
  },

  hints(): ReadonlyArray<readonly [string, string]> {
    return [
      ["↑↓", "select"],
      ["enter", "detail"],
      ["y", "copy approve"],
      ["n", "copy reject"],
    ];
  },
};
