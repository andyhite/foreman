/**
 * Shared by `wizard.ts`'s `provisionLabels` and `init.ts`'s
 * `provisionTeamForRepo`: the operator-facing side of `@foreman/core`'s
 * `provision.ts` — one confirmation prompt (itemized, never per-label or
 * per-state) and one `+`/`~`/`-`/`=`/`!` report line per `ProvisionAction`.
 */

import { groupDisplayName, labelDisplayName, type Confirmer, type ProvisionAction } from "@foreman/core";
import type { Prompter } from "./prompt.ts";
import { style } from "./tui.ts";

/** Wraps a `Prompter` as a `Confirmer`: prints `detail` lines, then asks the summary as a plain yes/no — no added prefix, since `provision.ts` already composes a complete, imperative question. */
export function promptConfirmer(prompter: Prompter, log: (message: string) => void): Confirmer {
  return {
    confirm: async ({ summary, detail }) => {
      for (const line of detail ?? []) log(`    ${line}`);
      return prompter.confirm(`${summary}?`, true);
    },
    close: () => {},
  };
}
/** `"type:bug"` -> `"Type: Bug"`; a bare group name like `"Type"` passes through unchanged. */
function formatLabelName(id: string): string {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) return id;
  const prefix = id.slice(0, colonIndex + 1);
  const child = id.slice(colonIndex + 1);
  return `${groupDisplayName(prefix)}: ${labelDisplayName(child)}`;
}

/** Display name for one action — Linear's own capitalization for labels, with `project-label` marked so it never reads as a duplicate of the matching issue label. */
function displayName(action: ProvisionAction): string {
  if (action.kind !== "label" && action.kind !== "project-label") return action.name;
  const formatted = formatLabelName(action.name);
  return action.kind === "project-label" ? `${formatted} (project)` : formatted;
}

/** One indented report line per action: `+` created, `~` updated, `-` archived, `=` already correct, `!` failed or declined. */
export function printProvisionAction(log: (message: string) => void, action: ProvisionAction): boolean {
  const name = displayName(action);
  if (action.changed) {
    const mark = action.op === "archive" ? style("red", "-") : action.op === "update" ? style("cyan", "~") : style("green", "+");
    log(`  ${mark} ${name}`);
    return false;
  }
  if (action.detail) {
    log(`  ${style("yellow", "!")} ${name} — ${action.detail}`);
    return true;
  }
  log(`  = ${name}`);
  return false;
}

/** Prints every action and reports whether any failed or was declined. */
export function printProvisionActions(log: (message: string) => void, actions: readonly ProvisionAction[]): boolean {
  let failed = false;
  for (const action of actions) {
    if (printProvisionAction(log, action)) failed = true;
  }
  return failed;
}
