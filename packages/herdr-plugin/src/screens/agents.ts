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

/**
 * One agent from `herdr agent list`, normalized.
 *
 * Verified against herdr 0.8.2: the command takes no `--json` flag (JSON is
 * the only output, and passing the flag is a usage error), the payload is
 * `{ id, result: { agents: [...] } }`, the lifecycle field is `agent_status`,
 * and there is no `name` field at all. Identity is `pane_id`, which `agent
 * focus` and `agent attach` both accept as a target.
 */
export interface HerdrAgent {
  /** Pane hosting this agent. The row carries no name, so this is the target. */
  paneId: string;
  /** Agent kind, e.g. `omp`. Wire field: `agent`. */
  kind: string;
  status: AgentStatus;
  /** Sidebar task title. Empty when herdr has not inferred one. */
  title: string;
  cwd: string;
  focused: boolean;
  workspaceId: string | null;
}

/** SPEC §17.3 state model. `unknown` does not prove completion. */
export type AgentStatus = "idle" | "working" | "blocked" | "unknown" | "done";

const AGENT_STATUS: Record<string, AgentStatus> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  unknown: "unknown",
};

export interface AgentsScreenState {
  agents: HerdrAgent[];
  view: ListViewState;
  status: string | null;
}

export function initialAgentsScreen(): AgentsScreenState {
  return { agents: [], view: initialListView(), status: null };
}

/**
 * Runs `herdr agent list` and parses the rows defensively: a non-zero exit or
 * an unrecognized payload degrades to an empty list rather than throwing.
 * This screen is ambient read-only status, not a control surface that must
 * succeed to keep the board safe.
 */
export async function loadAgentsScreen(config: GlobalConfig, run: RunCommand): Promise<HerdrAgent[]> {
  const result = await run(config.agent.herdrBin, ["agent", "list"]);
  if (result.exitCode !== 0) return [];
  return parseAgentList(result.stdout);
}

/** Exported for tests: the envelope walk is the part that broke twice. */
export function parseAgentList(stdout: string): HerdrAgent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("result" in parsed)) return [];
  const result = parsed.result;
  if (typeof result !== "object" || result === null || !("agents" in result)) return [];
  const rows = result.agents;
  if (!Array.isArray(rows)) return [];

  const agents: HerdrAgent[] = [];
  for (const row of rows) {
    const agent = toHerdrAgent(row);
    if (agent) agents.push(agent);
  }
  return agents;
}

/**
 * Reads a `string` property from an unvalidated JSON object, or null.
 * Seven fields need identical `in` + `typeof` narrowing, and doing it inline
 * seven times buries the mapping this function exists to show.
 */
function stringField(row: object, key: string): string | null {
  if (!(key in row)) return null;
  const value: unknown = Reflect.get(row, key);
  return typeof value === "string" ? value : null;
}

function toHerdrAgent(value: unknown): HerdrAgent | null {
  if (typeof value !== "object" || value === null) return null;

  const paneId = stringField(value, "pane_id");
  if (paneId === null) return null;

  return {
    paneId,
    kind: stringField(value, "agent") ?? "agent",
    // An unrecognized state is `unknown`, never silently treated as finished.
    status: AGENT_STATUS[stringField(value, "agent_status") ?? ""] ?? "unknown",
    title: stringField(value, "title") ?? "",
    cwd: stringField(value, "cwd") ?? "",
    focused: "focused" in value && Reflect.get(value, "focused") === true,
    workspaceId: stringField(value, "workspace_id"),
  };
}

function agentToListItem(agent: HerdrAgent): ListItem {
  const label = agent.title.length > 0 ? agent.title : `${agent.kind} in ${agent.paneId}`;
  return {
    label: `${label}  [${agent.status}]${agent.status === "blocked" ? "  \u26A0" : ""}`,
    detail: [
      `Pane: ${agent.paneId}${agent.focused ? "  (focused)" : ""}`,
      `Kind: ${agent.kind}`,
      agent.cwd.length > 0 ? `Cwd: ${agent.cwd}` : "",
      agent.status === "blocked"
        ? "ANOMALY: herdr recognized an approval/question UI. A Foreman agent should never sit at one (SPEC §17.3) — this is a bug, not a decision queue."
        : "",
      "",
      "Enter focuses this agent's pane, `A` attaches to it.",
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

/** `herdr agent focus <pane-id>` — brings the pane into view without leaving the board. */
export async function focusSelectedAgent(config: GlobalConfig, run: RunCommand, agent: HerdrAgent): Promise<string> {
  const result = await run(config.agent.herdrBin, ["agent", "focus", agent.paneId]);
  return result.exitCode === 0
    ? `Focused ${agent.paneId}.`
    : `Failed to focus ${agent.paneId}: ${result.stderr.trim()}`;
}

/** `herdr agent attach <pane-id>` — hands terminal control to the agent's pane. */
export async function attachSelectedAgent(config: GlobalConfig, run: RunCommand, agent: HerdrAgent): Promise<string> {
  const result = await run(config.agent.herdrBin, ["agent", "attach", agent.paneId]);
  return result.exitCode === 0
    ? `Attached ${agent.paneId}.`
    : `Failed to attach ${agent.paneId}: ${result.stderr.trim()}`;
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
