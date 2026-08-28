/**
 * Proposal review (SPEC §17.4) — the triage batch, per-item accept/reject,
 * keystroke-driven. `a` accepts the selected item, `r` starts a reject-reason
 * draft. Both route through `actions.ts`, never a direct mutation.
 */

import type { GlobalConfig, LinearClient, Theme } from "@foreman/core";
import { acceptProposal, rejectProposal } from "../actions.ts";
import { fetchProposalEntries, type ProposalEntry } from "../data.ts";
import type { Key } from "../tui/keys.ts";
import {
  initialListView,
  moveSelection,
  renderList,
  scrollToSelection,
  type ListItem,
  type ListViewState,
} from "../tui/list.ts";

export interface ProposalsScreenState {
  entries: ProposalEntry[];
  view: ListViewState;
  /** Non-null while composing a reject reason for the selected item. */
  draftReject: string | null;
  status: string | null;
}

export function initialProposalsScreen(): ProposalsScreenState {
  return { entries: [], view: initialListView(), draftReject: null, status: null };
}

export async function loadProposalsScreen(client: LinearClient): Promise<ProposalEntry[]> {
  const entries = await fetchProposalEntries(client);
  entries.sort((a, b) => a.issue.identifier.localeCompare(b.issue.identifier));
  return entries;
}

function entryToListItem(entry: ProposalEntry): ListItem {
  const item = entry.item;
  return {
    label: `${entry.issue.identifier}  ${item.type}  ${entry.issue.title}`,
    detail: [
      `Proposed priority: ${item.proposedPriority} — ${item.severityReasoning}`,
      `Destination: ${item.destination}`,
      `Project: ${item.destinationProject ?? "(none proposed)"}`,
      `Duplicate of: ${item.duplicateOf ?? "(none)"}`,
      `Repro confidence: ${item.reproConfidence}`,
      item.missingInfo.length > 0 ? `Missing info: ${item.missingInfo.join("; ")}` : "Missing info: (none)",
      "",
      "Press `a` to accept, `r` to reject (then type a reason, Enter to submit, Esc to cancel).",
    ],
  };
}

export interface ProposalsScreenUpdate {
  state: ProposalsScreenState;
  action: { kind: "accept" | "reject"; issueId: string; reason?: string } | null;
}

export function handleProposalsKey(
  state: ProposalsScreenState,
  key: Key,
  visibleRows: number,
): ProposalsScreenUpdate {
  const noop: ProposalsScreenUpdate = { state, action: null };
  const selected = state.entries[state.view.selected];

  if (state.draftReject !== null) {
    if (key.kind === "escape") return { state: { ...state, draftReject: null }, action: null };
    if (key.kind === "enter") {
      if (!selected || state.draftReject.trim().length === 0) return noop;
      return {
        state: { ...state, draftReject: null, status: `Rejecting ${selected.issue.identifier}…` },
        action: { kind: "reject", issueId: selected.issue.identifier, reason: state.draftReject.trim() },
      };
    }
    if (key.kind === "backspace") {
      return { state: { ...state, draftReject: state.draftReject.slice(0, -1) }, action: null };
    }
    if (key.kind === "char" || key.kind === "digit") {
      const char = key.kind === "digit" ? String(key.value) : key.value;
      return { state: { ...state, draftReject: state.draftReject + char }, action: null };
    }
    return noop;
  }

  if (key.kind === "up" || key.kind === "down") {
    const view = scrollToSelection(
      moveSelection(state.view, state.entries.length, key.kind === "up" ? -1 : 1),
      visibleRows,
    );
    return { state: { ...state, view }, action: null };
  }

  if (key.kind === "char" && key.value === "a" && selected) {
    return {
      state: { ...state, status: `Accepting ${selected.issue.identifier}…` },
      action: { kind: "accept", issueId: selected.issue.identifier },
    };
  }

  if (key.kind === "char" && key.value === "r" && selected) {
    return { state: { ...state, draftReject: "" }, action: null };
  }

  return noop;
}

export async function applyProposalAction(
  config: GlobalConfig,
  action: NonNullable<ProposalsScreenUpdate["action"]>,
): Promise<string> {
  const result =
    action.kind === "accept"
      ? await acceptProposal({ config }, action.issueId)
      : await rejectProposal({ config }, action.issueId, action.reason ?? "");
  if (result.ok) return `${action.kind === "accept" ? "Accepted" : "Rejected"} ${action.issueId}.`;
  return `Failed to ${action.kind} ${action.issueId}: ${result.stderr.trim() || result.stdout.trim()}`;
}

export function renderProposalsScreen(
  state: ProposalsScreenState,
  width: number,
  rows: number,
  theme: Theme,
): string {
  const listRows = Math.max(3, rows - 4);
  const items = state.entries.map(entryToListItem);
  const lines = renderList({
    title: `Proposals awaiting approval — ${state.entries.length}`,
    items,
    view: state.view,
    width,
    listRows,
    emptyMessage: "No proposals awaiting approval.",
    theme,
  });
  if (state.draftReject !== null) lines.push(theme.tone("selected", ` Reject reason> ${state.draftReject} `));
  if (state.status) lines.push(theme.tone(statusTone(state.status), state.status));
  return lines.join("\n");
}

function statusTone(status: string): "ok" | "danger" | "muted" {
  if (/^(Resolved|Accepted|Rejected)/.test(status)) return "ok";
  if (status.startsWith("Failed")) return "danger";
  return "muted";
}
