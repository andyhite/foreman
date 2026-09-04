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

export interface LoopLiveness {
  name: "plan" | "build";
  pid: number;
  startedAt: string;
}

export interface StatusState {
  needsInput: BlockedEntry[];
  blocked: BlockedEntry[];
  running: RunningEntry[];
  backlogCount: number;
  readyCount: number;
  loops: LoopLiveness[];
}

export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function renderBlockedSection(heading: string, entries: readonly BlockedEntry[], emptyText: string): string {
  const lines = entries.length > 0 ? entries.map((entry) => `- ${entry.issueId}: ${stripControlChars(entry.excerpt)}`).join("\n") : emptyText;
  return `## ${heading}\n\n${lines}`;
}

/**
 * Three sections: Needs Input (foreman-refine stalled), Blocked
 * (foreman-implement/foreman-review stalled — each with the latest `block`
 * marker excerpt), and Running (with `lockState`).
 */
export function renderStatusConsole(state: StatusState): string {
  const sections: string[] = [];

  const pastTtlCount = state.running.filter((entry) => entry.pastTtl).length;
  const humanQueueCount = state.needsInput.length + state.blocked.length;
  sections.push(
    `**${humanQueueCount} waiting on the operator (${state.needsInput.length} needs input, ${state.blocked.length} blocked) · ` +
      `${state.running.length} running (${pastTtlCount} past TTL) · ${state.readyCount} ready · ${state.backlogCount} backlog**`,
  );

  sections.push(renderBlockedSection("Needs Input", state.needsInput, "_none — nothing waiting on refinement_"));
  sections.push(renderBlockedSection("Blocked", state.blocked, "_none — nothing waiting on implementation_"));

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

  sections.push("## Loops");
  const loopLines = (["build", "plan"] as const).map((name) => {
    const loop = state.loops.find((entry) => entry.name === name);
    if (!loop) return `- ${name}: not running`;
    const upMs = Date.now() - new Date(loop.startedAt).getTime();
    return `- ${name}: running (pid ${loop.pid}, up ${formatAge(upMs)})`;
  });
  sections.push(loopLines.join("\n"));

  const boardEmpty =
    state.needsInput.length === 0 &&
    state.blocked.length === 0 &&
    state.running.length === 0 &&
    state.backlogCount === 0 &&
    state.readyCount === 0;
  const noLoopsRunning = state.loops.length === 0;
  if (boardEmpty && noLoopsRunning) {
    sections.push(
      "_Nothing queued. Seed a project with `/foreman:plan <PROJECT-ID>`, or start a loop with `foreman plan <alias>`._",
    );
  }

  return sections.join("\n\n");
}
