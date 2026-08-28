/**
 * The board (SPEC §17.4) — ambient: issues by state, per-worker WIP,
 * backpressure status and why it tripped, last run per worker. Navigation
 * and refresh only, no mutation — this screen never calls `actions.ts`.
 */

import {
  BLOCKED_HUMAN_FILTER,
  hasLabel,
  IN_FLIGHT_FILTER,
  type Issue,
  type LinearClient,
  PROPOSALS_FILTER,
  AGENT_LABEL,
  type Theme,
} from "@foreman/core";
import { fetchIssuesByState, readLoopBookkeeping, type LoopBookkeeping } from "../data.ts";
import type { GlobalConfig } from "@foreman/core";
import {
  initialListView,
  moveSelection,
  renderList,
  scrollToSelection,
  type ListItem,
  type ListViewState,
} from "../tui/list.ts";
import type { Key } from "../tui/keys.ts";

export interface BoardScreenState {
  issuesByState: Map<string, Issue[]>;
  wipByStage: Record<string, number>;
  blockedCount: number;
  proposedCount: number;
  backpressureTripped: boolean;
  bookkeeping: LoopBookkeeping;
  view: ListViewState;
  stage: string;
  wipCaps: { refine: number; implement: number; review: number };
  wipGlobal: number;
  backpressureThreshold: number;
  intakeWindow: string;
}

const STAGES = ["intake", "refine", "implement", "review"] as const;

export async function loadBoardScreen(client: LinearClient, config: GlobalConfig): Promise<BoardScreenState> {
  const [issues, blocked, running] = await Promise.all([
    fetchIssuesByState(client),
    client.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
    client.issues({ filter: IN_FLIGHT_FILTER, limit: 500 }),
  ]);
  const proposedCount = (await client.issues({ filter: PROPOSALS_FILTER, limit: 500 })).length;

  const issuesByState = new Map<string, Issue[]>();
  for (const issue of issues) {
    const bucket = issuesByState.get(issue.state.name) ?? [];
    bucket.push(issue);
    issuesByState.set(issue.state.name, bucket);
  }

  const wipByStage: Record<string, number> = { intake: 0, refine: 0, implement: 0, review: 0 };
  for (const issue of running) {
    const stage = stageForIssue(issue);
    if (stage) wipByStage[stage] = (wipByStage[stage] ?? 0) + 1;
  }

  return {
    issuesByState,
    wipByStage,
    blockedCount: blocked.length,
    proposedCount,
    backpressureTripped: blocked.length >= config.loop.backpressureThreshold,
    bookkeeping: readLoopBookkeeping(config),
    view: initialListView(),
    stage: config.loop.stage,
    wipCaps: { ...config.loop.wip },
    wipGlobal: config.loop.wipGlobal,
    backpressureThreshold: config.loop.backpressureThreshold,
    intakeWindow: config.intake.window,
  };
}

/**
 * Best-effort stage inference from an in-flight issue's workflow state
 * category, since the running set carries no explicit stage tag of its own —
 * `agent:running` is the mutex, not a stage label (SPEC §11, §17.5).
 */
function stageForIssue(issue: Issue): (typeof STAGES)[number] | null {
  if (hasLabel(issue, AGENT_LABEL.running)) {
    if (issue.state.type === "triage") return "intake";
    if (issue.state.type === "started") return issue.state.name === "In Review" ? "review" : "implement";
    if (issue.state.type === "backlog" || issue.state.type === "unstarted") return "refine";
  }
  return null;
}

function stateToListItem(stateName: string, issues: Issue[]): ListItem {
  return {
    label: `${stateName} (${issues.length})`,
    detail: issues.slice(0, 30).map((issue) => `  ${issue.identifier}  ${issue.title}`),
  };
}

export function handleBoardKey(state: BoardScreenState, key: Key, visibleRows: number): BoardScreenState {
  if (key.kind !== "up" && key.kind !== "down") return state;
  const stateNames = [...state.issuesByState.keys()];
  const view = scrollToSelection(
    moveSelection(state.view, stateNames.length, key.kind === "up" ? -1 : 1),
    visibleRows,
  );
  return { ...state, view };
}

export function renderBoardScreen(state: BoardScreenState, width: number, rows: number, theme: Theme): string {
  const listRows = Math.max(3, rows - 10);
  const stateNames = [...state.issuesByState.keys()].sort();
  const items = stateNames.map((name) => stateToListItem(name, state.issuesByState.get(name) ?? []));
  const lines = renderList({
    title: "Board",
    items,
    view: state.view,
    width,
    listRows,
    emptyMessage: "No issues found for the configured teams.",
    theme,
  });

  const footer = footerLines(state, width, theme);
  lines.push("", ...footer);

  return lines.join("\n");
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? text.slice(0, width) : text;
}

function formatAge(iso: string | null): string {
  if (iso === null) return "never";
  const elapsedMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m ago`;
}

function footerLines(state: BoardScreenState, width: number, theme: Theme): string[] {
  const lines: string[] = [];

  const stageLine =
    state.stage === "dry-run" ? `Stage: ${state.stage} — dispatching nothing` : `Stage: ${state.stage}`;
  lines.push(theme.tone(state.stage === "dry-run" ? "warn" : "muted", truncate(stageLine, width)));

  const wipTokens = (["refine", "implement", "review"] as const).map((name) => {
    const used = state.wipByStage[name] ?? 0;
    const cap = state.wipCaps[name];
    const token = `${name}:${used}/${cap}`;
    return used >= cap ? theme.tone("warn", token) : token;
  });
  lines.push(truncate(`WIP  ${wipTokens.join(" ")}  (global cap ${state.wipGlobal})`, width));

  const backpressureText = state.backpressureTripped
    ? `Backpressure TRIPPED — ${state.blockedCount} blocked issue(s) at or above threshold. Loop is not dispatching.`
    : `Backpressure clear — ${state.blockedCount} blocked issue(s).`;
  const backpressureTone = state.backpressureTripped
    ? "danger"
    : state.blockedCount >= state.backpressureThreshold - 2
      ? "warn"
      : "muted";
  lines.push(theme.tone(backpressureTone, truncate(backpressureText, width)));

  const proposalsText = `Proposals awaiting approval: ${state.proposedCount}`;
  lines.push(
    state.proposedCount > 0
      ? theme.tone("accent", truncate(proposalsText, width))
      : truncate(proposalsText, width),
  );

  const lastRunTokens = STAGES.map((stage) => {
    const at = state.bookkeeping.lastRunAt[stage] ?? null;
    const token = `${stage} ${formatAge(at)}`;
    if (at === null) return theme.tone("warn", token);
    const ageMinutes = (Date.now() - new Date(at).getTime()) / 60_000;
    return ageMinutes > 30 ? theme.tone("muted", token) : token;
  });
  lines.push(truncate(`Last run  ${lastRunTokens.join(" · ")}`, width));

  const retryingCount = Object.keys(state.bookkeeping.attempts).length;
  const pendingCount = state.bookkeeping.pendingDecisions.length;
  if (retryingCount > 0 || pendingCount > 0) {
    const retryText = `Retries: ${retryingCount} issue(s) retrying · ${pendingCount} awaiting decision`;
    lines.push(pendingCount > 0 ? theme.tone("danger", truncate(retryText, width)) : truncate(retryText, width));
  }

  lines.push(theme.tone("muted", truncate(`Intake window: ${state.intakeWindow}`, width)));

  return lines;
}
