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
}

const STAGES = ["triage", "refine", "implement", "review"] as const;

export async function loadBoardScreen(client: LinearClient, config: GlobalConfig): Promise<BoardScreenState> {
  const [issues, blocked, running] = await Promise.all([
    fetchIssuesByState(client, config.linear.teamKeys),
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

  const wipByStage: Record<string, number> = { triage: 0, refine: 0, implement: 0, review: 0 };
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
  };
}

/**
 * Best-effort stage inference from an in-flight issue's workflow state
 * category, since the running set carries no explicit stage tag of its own —
 * `agent:running` is the mutex, not a stage label (SPEC §11, §17.5).
 */
function stageForIssue(issue: Issue): (typeof STAGES)[number] | null {
  if (hasLabel(issue, AGENT_LABEL.running)) {
    if (issue.state.type === "triage") return "triage";
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

export function renderBoardScreen(state: BoardScreenState, width: number, rows: number): string {
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
  });

  lines.push("");
  lines.push(
    `WIP  triage:${state.wipByStage.triage ?? 0} refine:${state.wipByStage.refine ?? 0} ` +
      `implement:${state.wipByStage.implement ?? 0} review:${state.wipByStage.review ?? 0}`,
  );
  lines.push(
    state.backpressureTripped
      ? `Backpressure TRIPPED — ${state.blockedCount} blocked issue(s) at or above threshold. Loop is not dispatching.`
      : `Backpressure clear — ${state.blockedCount} blocked issue(s).`,
  );
  lines.push(`Proposals awaiting approval: ${state.proposedCount}`);
  const lastRun = STAGES.map((stage) => `${stage}:${state.bookkeeping.lastRunAt[stage] ?? "never"}`).join(" ");
  lines.push(`Last run  ${lastRun}`);

  return lines.map((line) => (line.length > width ? line.slice(0, width) : line)).join("\n");
}
