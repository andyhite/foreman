/**
 * Single source of truth for every operator-facing key binding.
 *
 * `HELP_ENTRIES` feeds the help modal; `GLOBAL_KEY_HINTS` feeds the footer.
 * Docs tooling can import `KEYMAP` (structured rows with scope/view metadata)
 * to regenerate README key tables — do not duplicate bindings elsewhere.
 */

export interface KeymapEntry {
  readonly keys: string;
  readonly description: string;
  readonly scope: "global" | "view";
  readonly view?: string;
}

export const KEYMAP: readonly KeymapEntry[] = [
  { keys: "?", description: "toggle help", scope: "global" },
  { keys: "q", description: "quit (confirm when loops run)", scope: "global" },
  { keys: "ctrl-c", description: "quit (confirm when loops run)", scope: "global" },
  { keys: "1-7", description: "jump to view", scope: "global" },
  { keys: "tab", description: "next view", scope: "global" },
  { keys: "shift-tab", description: "previous view", scope: "global" },
  { keys: "L", description: "cycle focused loop", scope: "global" },
  { keys: "r", description: "refresh snapshot", scope: "global" },
  { keys: "s", description: "start focused loop", scope: "global" },
  { keys: "S", description: "stop focused loop", scope: "global" },
  { keys: "p", description: "pause / resume focused loop", scope: "global" },
  { keys: "t", description: "tick focused loop", scope: "global" },
  { keys: "g", description: "cycle autonomy stage", scope: "global" },
  { keys: "↑↓", description: "select row", scope: "view", view: "agents" },
  { keys: "enter / a", description: "attach agent", scope: "view", view: "agents" },
  { keys: "x", description: "kill agent", scope: "view", view: "agents" },
  { keys: "o", description: "open issue", scope: "view", view: "agents" },
  { keys: "↑↓", description: "select worker", scope: "view", view: "overview" },
  { keys: "enter", description: "skip to agents", scope: "view", view: "overview" },
  { keys: "↑↓", description: "select issue", scope: "view", view: "pipeline" },
  { keys: "enter", description: "issue detail", scope: "view", view: "pipeline" },
  { keys: "o", description: "open issue", scope: "view", view: "pipeline" },
  { keys: "/", description: "filter", scope: "view", view: "pipeline" },
  { keys: "↑↓", description: "select block", scope: "view", view: "blocks" },
  { keys: "enter / u", description: "reply command", scope: "view", view: "blocks" },
  { keys: "y", description: "copy unblock command", scope: "view", view: "blocks" },
  { keys: "↑↓", description: "select proposal", scope: "view", view: "proposals" },
  { keys: "enter", description: "proposal detail", scope: "view", view: "proposals" },
  { keys: "y / n", description: "approve / reject command", scope: "view", view: "proposals" },
  { keys: "y", description: "copy apply command", scope: "view", view: "proposals" },
  { keys: "f", description: "follow / pin tail", scope: "view", view: "logs" },
  { keys: "/", description: "substring filter", scope: "view", view: "logs" },
  { keys: "A", description: "focused / all loops", scope: "view", view: "logs" },
  { keys: "enter", description: "edit field", scope: "view", view: "settings" },
  { keys: "←/→", description: "adjust value", scope: "view", view: "settings" },
  { keys: "space", description: "toggle boolean", scope: "view", view: "settings" },
  { keys: "ctrl-s", description: "save config", scope: "view", view: "settings" },
  { keys: "esc", description: "discard edits", scope: "view", view: "settings" },
] as const;

/** Footer global hints (rightmost segment of every view's footer). */
export const GLOBAL_KEY_HINTS: ReadonlyArray<readonly [string, string]> = KEYMAP.filter(
  (entry) => entry.scope === "global",
).map((entry) => [entry.keys, entry.description] as const);

/** Help modal rows — human-oriented grouping, derived from the same table. */
export const HELP_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["?", "toggle help"],
  ["q / ctrl-c", "quit (confirm when loops run)"],
  ["1-7", "jump to view"],
  ["tab / shift-tab", "next / previous view"],
  ["L", "cycle focused loop"],
  ["r", "refresh snapshot"],
  ["s / S", "start / stop focused loop"],
  ["p / t", "pause-resume / tick focused loop"],
  ["g", "cycle autonomy stage"],
  ["agents", "↑↓ select · enter attach · x kill · o open"],
  ["overview", "↑↓ worker · enter skips"],
  ["pipeline", "↑↓ select · enter detail · o open · / filter"],
  ["blocks", "↑↓ select · enter reply · u reply · y copy command"],
  ["proposals", "↑↓ select · enter detail · y/n command · y copy"],
  ["logs", "f follow · / filter · A focused/all loops"],
  ["settings", "enter edit · ←/→ adjust · space toggle · ctrl-s save"],
];
