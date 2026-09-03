/**
 * `/foreman:status` operator console (SPEC §3.4, §17.4). Not a Linear
 * artifact — this renders in-chat, so it stays terminal-readable rather than
 * matching the Markdown conventions of the other renderers.
 */

import { stripControlChars } from "@foreman/core";

export interface BlockedEntry {
  issueId: string;
  excerpt: string;
}

export interface RunningEntry {
  issueId: string;
  agent: string;
  dispatchId: string;
  ageMs: number;
  pastTtl: boolean;
}

export interface StatusState {
  blocked: BlockedEntry[];
  running: RunningEntry[];
}

function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/**
 * Two sections only, per the `foreman:` vocabulary: Blocked (`foreman:blocked`,
 * with the latest `block` marker excerpt) and Running (`foreman:running`,
 * with `lockState`).
 */
export function renderStatusConsole(state: StatusState): string {
  const sections: string[] = [];

  const pastTtlCount = state.running.filter((entry) => entry.pastTtl).length;
  sections.push(`**${state.blocked.length} blocked · ${state.running.length} running (${pastTtlCount} past TTL)**`);

  sections.push("## Blocked");
  sections.push(
    state.blocked.length > 0
      ? state.blocked.map((entry) => `- ${entry.issueId}: ${stripControlChars(entry.excerpt)}`).join("\n")
      : "_none — nothing waiting on the operator_",
  );

  sections.push("## Running");
  sections.push(
    state.running.length > 0
      ? state.running
          .map(
            (entry) =>
              `- ${entry.pastTtl ? "⚠ " : ""}${entry.issueId} held by ${entry.agent} (dispatch ${entry.dispatchId}, ` +
              `age ${formatAge(entry.ageMs)}${entry.pastTtl ? ", **PAST TTL**" : ""})`,
          )
          .join("\n")
      : "_none_",
  );

  return sections.join("\n\n");
}
