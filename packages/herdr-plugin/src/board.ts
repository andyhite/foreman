#!/usr/bin/env bun
/**
 * Herdr pane entrypoint and screen router (SPEC §17.4). Invoked by
 * `herdr plugin pane open --plugin foreman --entrypoint <blocked|proposals|board|agents>`;
 * `HERDR_PLUGIN_ENTRYPOINT_ID` (or `argv[2]` for manual runs) selects which
 * screen opens first. Tab cycles between screens within one pane process —
 * the manifest opens four separate panes (SPEC §17.4 table), but nothing
 * stops the operator from cycling once inside one.
 *
 * The board is a view, not a control plane (SPEC §17.4, §19): it holds no
 * queue of its own. Every screen re-reads Linear on refresh and writes
 * nothing directly — mutations go through `actions.ts`.
 */

import { buildLinearClient, loadBoardConfig } from "./data.ts";
import { defaultTheme } from "@foreman/core";
import { defaultRunCommand, type ActionsOptions } from "./actions.ts";
import { KeyDecoder, type Key } from "./tui/keys.ts";
import { openTerminal } from "./tui/terminal.ts";
import {
  handleBlockedKey,
  initialBlockedScreen,
  loadBlockedScreen,
  renderBlockedScreen,
  resolveSelectedBlock,
  type BlockedScreenState,
} from "./screens/blocked.ts";
import {
  applyProposalAction,
  handleProposalsKey,
  initialProposalsScreen,
  loadProposalsScreen,
  renderProposalsScreen,
  type ProposalsScreenState,
} from "./screens/proposals.ts";
import { handleBoardKey, loadBoardScreen, renderBoardScreen, type BoardScreenState } from "./screens/board.ts";
import {
  attachSelectedAgent,
  focusSelectedAgent,
  handleAgentsKey,
  initialAgentsScreen,
  loadAgentsScreen,
  renderAgentsScreen,
  type AgentsScreenState,
} from "./screens/agents.ts";

type ScreenId = "blocked" | "proposals" | "board" | "agents";
const SCREEN_ORDER: ScreenId[] = ["blocked", "proposals", "board", "agents"];

const LEGEND: Record<ScreenId, string> = {
  blocked:
    "↑/↓ move · 1-9 pick option · type a reply · Enter submit · Esc cancel · Ctrl-R refresh · Tab screen · q quit",
  proposals:
    "↑/↓ move · a accept · r reject · Enter submit reason · Esc cancel · Ctrl-R refresh · Tab screen · q quit",
  board: "↑/↓ move · Ctrl-R refresh · Tab screen · q quit",
  agents: "↑/↓ move · Enter focus pane · A attach · Ctrl-R refresh · Tab screen · q quit",
};

function resolveEntrypoint(): ScreenId {
  const raw = process.env.HERDR_PLUGIN_ENTRYPOINT_ID ?? process.argv[2] ?? "blocked";
  return (SCREEN_ORDER as string[]).includes(raw) ? (raw as ScreenId) : "blocked";
}

/**
 * True while a blocked-reply or proposal-reject draft is in progress —
 * `handleKey` skips the global `q`/`Tab` shortcuts in that state so a typed
 * character never quits the board or discards the draft (SPEC §17.4).
 */
export function isComposingDraft(
  screen: ScreenId,
  blocked: BlockedScreenState,
  proposals: ProposalsScreenState,
): boolean {
  return (
    (screen === "blocked" && blocked.draftReply !== null) ||
    (screen === "proposals" && proposals.draftReject !== null)
  );
}

/** Entry point. Not invoked when this module is imported for testing. */
export async function runBoard(): Promise<void> {
  const config = loadBoardConfig();
  const client = buildLinearClient(config);
  const actionsOptions: ActionsOptions = { config, runCommand: defaultRunCommand };
  const theme = defaultTheme;

  let screen: ScreenId = resolveEntrypoint();
  let blocked: BlockedScreenState = initialBlockedScreen();
  let proposals: ProposalsScreenState = initialProposalsScreen();
  let board: BoardScreenState | null = null;
  let agents: AgentsScreenState = initialAgentsScreen();
  let refreshing = false;

  const terminal = openTerminal();
  const decoder = new KeyDecoder();

  async function refresh(): Promise<void> {
    refreshing = true;
    render();
    if (screen === "blocked") blocked = { ...blocked, entries: await loadBlockedScreen(client) };
    if (screen === "proposals") proposals = { ...proposals, entries: await loadProposalsScreen(client) };
    if (screen === "board") board = await loadBoardScreen(client, config);
    if (screen === "agents") agents = { ...agents, agents: await loadAgentsScreen(config, defaultRunCommand) };
    refreshing = false;
    render();
  }

  function render(): void {
    const { columns, rows } = terminal.size();
    if (rows < 12 || columns < 40) {
      terminal.writeFrame("Terminal too small — need at least 40×12.");
      return;
    }
    const tabs = SCREEN_ORDER.map((id) => theme.tone(id === screen ? "selected" : "muted", id)).join(" · ");
    const refreshIndicator = refreshing ? theme.tone("accent", " ⟳ refreshing…") : "";
    const headerLine1 = `${theme.tone("title", "Foreman")} ${tabs}${refreshIndicator}`;
    const headerLine2 = theme.tone("muted", LEGEND[screen]);
    let body: string;
    if (screen === "blocked") body = renderBlockedScreen(blocked, columns, rows - 3, theme);
    else if (screen === "proposals") body = renderProposalsScreen(proposals, columns, rows - 3, theme);
    else if (screen === "board")
      body = board ? renderBoardScreen(board, columns, rows - 3, theme) : "Loading board…";
    else body = renderAgentsScreen(agents, columns, rows - 3, theme);
    terminal.writeFrame(`${headerLine1}\n${headerLine2}\n${body}`);
  }

  async function handleKey(key: Key): Promise<void> {
    const composing = isComposingDraft(screen, blocked, proposals);

    if (key.kind === "ctrl" && key.value === "r") {
      await refresh();
      return;
    }

    if (key.kind === "tab" && !composing) {
      const index = SCREEN_ORDER.indexOf(screen);
      screen = SCREEN_ORDER[(index + 1) % SCREEN_ORDER.length] ?? "blocked";
      await refresh();
      return;
    }
    if (key.kind === "char" && key.value === "q" && !composing) {
      terminal.stop();
      process.exit(0);
    }

    const { rows } = terminal.size();
    const visibleRows = Math.max(3, rows - 6);

    if (screen === "blocked") {
      const update = handleBlockedKey(blocked, key, visibleRows);
      blocked = update.state;
      if (update.resolveIssueId && update.resolveReply) {
        const message = await resolveSelectedBlock(config, update.resolveIssueId, update.resolveReply);
        blocked = { ...blocked, status: message };
        await refresh();
        return;
      }
      render();
      return;
    }

    if (screen === "proposals") {
      const update = handleProposalsKey(proposals, key, visibleRows);
      proposals = update.state;
      if (update.action) {
        const message = await applyProposalAction(config, update.action);
        proposals = { ...proposals, status: message };
        await refresh();
        return;
      }
      render();
      return;
    }

    if (screen === "board" && board) {
      board = handleBoardKey(board, key, visibleRows);
      render();
      return;
    }

    if (screen === "agents") {
      if (key.kind === "enter" || (key.kind === "char" && key.value === "A")) {
        const selected = agents.agents[agents.view.selected];
        if (selected) {
          const message =
            key.kind === "enter"
              ? await focusSelectedAgent(config, defaultRunCommand, selected)
              : await attachSelectedAgent(config, defaultRunCommand, selected);
          agents = { ...agents, status: message };
          render();
          return;
        }
      }
      agents = handleAgentsKey(agents, key, visibleRows);
      render();
      return;
    }
  }

  terminal.onKey((chunk) => {
    for (const key of decoder.push(chunk)) {
      void handleKey(key);
    }
  });
  terminal.onResize(() => render());

  const escapeFlush = setInterval(() => {
    const key = decoder.flushPendingEscape();
    if (key) void handleKey(key);
  }, 50);
  process.on("exit", () => clearInterval(escapeFlush));

  await refresh();
}

if (import.meta.main) {
  await runBoard();
}
