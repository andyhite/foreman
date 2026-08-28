/**
 * The blocked drain (SPEC §17.4) — highest-value screen in the system. Lists
 * every `BlockRecord`, lets the operator resolve one with a keypress: a digit
 * picks an enumerated option, any other typed line is a free-text reply.
 * Resolving shells `/foreman:unblock` through `actions.ts` — the same write
 * path the operator would type — then refreshes from Linear.
 */

import type { GlobalConfig, LinearClient } from "@foreman/core";
import { resolveBlock } from "../actions.ts";
import { fetchBlockedEntries, type BlockedEntry } from "../data.ts";
import type { Key } from "../tui/keys.ts";
import {
  initialListView,
  moveSelection,
  renderList,
  scrollToSelection,
  type ListItem,
  type ListViewState,
} from "../tui/list.ts";

export interface BlockedScreenState {
  entries: BlockedEntry[];
  view: ListViewState;
  /** Non-null while the operator is composing a free-text reply. */
  draftReply: string | null;
  status: string | null;
}

export function initialBlockedScreen(): BlockedScreenState {
  return { entries: [], view: initialListView(), draftReply: null, status: null };
}

export async function loadBlockedScreen(client: LinearClient): Promise<BlockedEntry[]> {
  const entries = await fetchBlockedEntries(client);
  entries.sort((a, b) => a.issue.identifier.localeCompare(b.issue.identifier));
  return entries;
}

function entryToListItem(entry: BlockedEntry): ListItem {
  const record = entry.record;
  const optionLines =
    record.options?.map((option, index) => `  [${index + 1}] ${option.label} — ${option.tradeoff}`) ?? [];
  return {
    label: `${entry.issue.identifier}  ${record.type}  ${entry.issue.title}`,
    detail: [
      `What I was doing: ${record.whatIWasDoing}`,
      `What I need: ${record.whatINeed}`,
      ...(optionLines.length > 0 ? ["Options:", ...optionLines] : []),
      `Recommendation: ${record.recommendation ?? "(none stated)"}`,
      `Worktree: ${record.stateLeftBehind.worktree ?? "(none)"}  Branch: ${record.stateLeftBehind.branch ?? "(none)"}  Pushed: ${record.stateLeftBehind.pushed}`,
      `Cost of a wrong guess: ${record.costOfWrongGuess}`,
      "",
      "Press a digit to pick an option, or type a reply and press Enter. Esc cancels.",
    ],
  };
}

export interface BlockedScreenUpdate {
  state: BlockedScreenState;
  /** Set when the operator resolved an entry this keypress and needs a re-fetch. */
  resolveIssueId: string | null;
  resolveReply: string | null;
}

/**
 * Pure key-handling step. `visibleRows` sizes the scroll window. Digit keys
 * resolve the selected entry immediately with the matching enumerated
 * option's label; any other printable character starts or extends a
 * free-text draft; Enter submits the draft; Escape cancels it.
 */
export function handleBlockedKey(
  state: BlockedScreenState,
  key: Key,
  visibleRows: number,
): BlockedScreenUpdate {
  const noop: BlockedScreenUpdate = { state, resolveIssueId: null, resolveReply: null };
  const selected = state.entries[state.view.selected];

  if (state.draftReply !== null) {
    if (key.kind === "escape") {
      return { state: { ...state, draftReply: null }, resolveIssueId: null, resolveReply: null };
    }
    if (key.kind === "enter") {
      if (!selected || state.draftReply.trim().length === 0) return noop;
      return {
        state: { ...state, draftReply: null, status: `Resolving ${selected.issue.identifier}…` },
        resolveIssueId: selected.issue.identifier,
        resolveReply: state.draftReply.trim(),
      };
    }
    if (key.kind === "backspace") {
      return {
        state: { ...state, draftReply: state.draftReply.slice(0, -1) },
        resolveIssueId: null,
        resolveReply: null,
      };
    }
    if (key.kind === "char" || key.kind === "digit") {
      const char = key.kind === "digit" ? String(key.value) : key.value;
      return { state: { ...state, draftReply: state.draftReply + char }, resolveIssueId: null, resolveReply: null };
    }
    return noop;
  }

  if (key.kind === "up" || key.kind === "down") {
    const view = scrollToSelection(
      moveSelection(state.view, state.entries.length, key.kind === "up" ? -1 : 1),
      visibleRows,
    );
    return { state: { ...state, view }, resolveIssueId: null, resolveReply: null };
  }

  if (key.kind === "digit" && selected) {
    const option = selected.record.options?.[key.value - 1];
    if (!option) return noop;
    return {
      state: { ...state, status: `Resolving ${selected.issue.identifier}…` },
      resolveIssueId: selected.issue.identifier,
      resolveReply: option.label,
    };
  }

  if (key.kind === "char" && selected) {
    return { state: { ...state, draftReply: key.value }, resolveIssueId: null, resolveReply: null };
  }

  return noop;
}

/** Invokes `/foreman:unblock` through the one write path and returns the outcome message. */
export async function resolveSelectedBlock(
  config: GlobalConfig,
  issueId: string,
  reply: string,
): Promise<string> {
  const result = await resolveBlock({ config }, issueId, reply);
  return result.ok
    ? `Resolved ${issueId}.`
    : `Failed to resolve ${issueId}: ${result.stderr.trim() || result.stdout.trim()}`;
}

export function renderBlockedScreen(state: BlockedScreenState, width: number, rows: number): string {
  const listRows = Math.max(3, rows - 4);
  const items = state.entries.map(entryToListItem);
  const lines = renderList({
    title: `Blocked (human) — ${state.entries.length} awaiting`,
    items,
    view: state.view,
    width,
    listRows,
    emptyMessage: "Nothing blocked. Drain is empty.",
  });
  if (state.draftReply !== null) lines.push(`Reply> ${state.draftReply}`);
  if (state.status) lines.push(state.status);
  return lines.join("\n");
}
