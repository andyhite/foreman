/**
 * Agent detail (SPEC §17.4) — live herdr agent status, jump-to-pane and
 * attach. Herdr agent state drives ordering and display only, never routing
 * (SPEC §17.3): nothing here writes Linear or decides what the loop does
 * next. A herdr `blocked` agent is rendered as an anomaly — the design says
 * agents never hit approval prompts, so a recognized approval UI means a
 * Foreman bug, not a normal queue entry.
 */

import type { GlobalConfig } from "@foreman/core";
import type { RunCommand } from "../actions.ts";
import type { Key } from "../tui/keys.ts";
import {
  initialListView,
  moveSelection,
  renderList,
  scrollToSelection,
  type ListItem,
  type ListViewState,
} from "../tui/list.ts";

/** One row of `herdr agent list --json` (SPEC §17.3 state model; field names as documented). */
export interface HerdrAgent {
  name: string;
  status: "idle" | "working" | "blocked" | "unknown" | "done";
  pane_id: string;
  workspace_id?: string;
}

export interface AgentsScreenState {
  agents: HerdrAgent[];
  view: ListViewState;
  status: string | null;
}

export function initialAgentsScreen(): AgentsScreenState {
  return { agents: [], view: initialListView(), status: null };
}

/**
 * Runs `herdr agent list --json` and parses the agent rows defensively — an
 * unparseable or empty response degrades to an empty list rather than
 * throwing, since this screen is read-only ambient status, not a control
 * surface that must succeed to be safe.
 *
 * UNVERIFIED: the `--json` flag and the `name`/`status`/`pane_id`/
 * `workspace_id` field names are inferred from the contract's CLI summary,
 * not confirmed against `herdr agent list --help` or real output. Do not
 * "fix" the defensive parsing into a strict decode if a mismatch surfaces —
 * degrading to an empty list is the intended behavior until this is checked.
 */
export async function loadAgentsScreen(config: GlobalConfig, run: RunCommand): Promise<HerdrAgent[]> {
  const result = await run(config.agent.herdrBin, ["agent", "list", "--json"]);
  if (result.exitCode !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHerdrAgent);
  } catch {
    return [];
  }
}

function isHerdrAgent(value: unknown): value is HerdrAgent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.status === "string" &&
    typeof record.pane_id === "string"
  );
}

function agentToListItem(agent: HerdrAgent): ListItem {
  const anomaly = agent.status === "blocked" ? "  ANOMALY: herdr recognized an approval/question UI — this means a Foreman bug (SPEC §17.3), not a decision queue." : "";
  return {
    label: `${agent.name}  [${agent.status}]${agent.status === "blocked" ? "  \u26A0" : ""}`,
    detail: [
      `Pane: ${agent.pane_id}`,
      agent.workspace_id ? `Workspace: ${agent.workspace_id}` : "",
      anomaly,
      "",
      "Press Enter to focus this agent's pane, `A` to attach.",
    ].filter((line) => line.length > 0),
  };
}

export function handleAgentsKey(state: AgentsScreenState, key: Key, visibleRows: number): AgentsScreenState {
  if (key.kind === "up" || key.kind === "down") {
    const view = scrollToSelection(
      moveSelection(state.view, state.agents.length, key.kind === "up" ? -1 : 1),
      visibleRows,
    );
    return { ...state, view };
  }
  return state;
}

/** `herdr agent focus <name>` — brings the agent's pane into view without leaving the board. */
export async function focusSelectedAgent(config: GlobalConfig, run: RunCommand, agent: HerdrAgent): Promise<string> {
  const result = await run(config.agent.herdrBin, ["agent", "focus", agent.name]);
  return result.exitCode === 0 ? `Focused ${agent.name}.` : `Failed to focus ${agent.name}: ${result.stderr.trim()}`;
}

/** `herdr agent attach <name>` — hands terminal control to the agent's pane. */
export async function attachSelectedAgent(config: GlobalConfig, run: RunCommand, agent: HerdrAgent): Promise<string> {
  const result = await run(config.agent.herdrBin, ["agent", "attach", agent.name]);
  return result.exitCode === 0 ? `Attached ${agent.name}.` : `Failed to attach ${agent.name}: ${result.stderr.trim()}`;
}

export function renderAgentsScreen(state: AgentsScreenState, width: number, rows: number): string {
  const listRows = Math.max(3, rows - 4);
  const items = state.agents.map(agentToListItem);
  const lines = renderList({
    title: `Agents — ${state.agents.length} live`,
    items,
    view: state.view,
    width,
    listRows,
    emptyMessage: "No live agents.",
  });
  if (state.status) lines.push(state.status);
  return lines.join("\n");
}
