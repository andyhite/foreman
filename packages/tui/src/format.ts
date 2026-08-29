/**
 * Small, pure formatters shared by every view (contract section Q).
 *
 * The TUI redraws on a fixed clock (`TuiRuntime`'s tick), not on wall-clock
 * change, so every "relative" string here takes `now` as an explicit
 * parameter instead of calling `Date.now()` itself — that keeps `reduce` and
 * every view's rendering deterministic and testable without faking the
 * system clock.
 */

import type { AgentStatus, LoopStage, RunState } from "@foreman/core";
import type { BadgeKind, ToneName } from "@foreman/core";

/** "12s", "4m", "2h", "3d", "—" for null or unparseable input. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const deltaMs = Math.max(0, now - then);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** "1h 12m", "45s" — the two most significant units only. */
export function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** "14:32:07" in local time, "—" for null/unparseable. */
export function shortIso(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toTimeString().slice(0, 8);
}

const PRIORITY_GLYPHS: Record<number, string> = { 0: "·", 1: "!", 2: "▲", 3: "■", 4: "▼" };
const PRIORITY_LABELS: Record<number, string> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

export function priorityGlyph(priority: number): string {
  return PRIORITY_GLYPHS[priority] ?? "·";
}

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? "none";
}

export function stateTone(state: RunState): BadgeKind {
  switch (state) {
    case "running":
      return "ok";
    case "starting":
      return "info";
    case "paused":
      return "warn";
    case "draining":
      return "warn";
    case "stopped":
      return "muted";
    default:
      return "muted";
  }
}

export function stageTone(stage: LoopStage): BadgeKind {
  switch (stage) {
    case "full":
      return "ok";
    case "read-only":
      return "warn";
    case "dry-run":
      return "muted";
    default:
      return "muted";
  }
}

export function agentStatusTone(status: AgentStatus): BadgeKind {
  switch (status) {
    case "running":
      return "ok";
    case "starting":
      return "info";
    case "settled":
      return "muted";
    case "lost":
      return "danger";
    case "unknown":
      return "warn";
    default:
      return "muted";
  }
}

/**
 * The `ToneName` that paints each `BadgeKind`.
 *
 * `badge()` takes a `BadgeKind`, but a table's `Column.sgr` slot needs a raw
 * SGR prefix from `theme.toneSgr(…)` — and passing a badge kind there paints
 * the literal word "danger" into the cell instead of colouring it.
 */
export const TONE_BY_BADGE: Record<BadgeKind, ToneName> = {
  ok: "badgeOk",
  warn: "badgeWarn",
  danger: "badgeDanger",
  muted: "badgeMuted",
  info: "info",
};

/** "in 42s", "due", "—" for null/unparseable. */
export function countdown(iso: string | null, now: number): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const deltaMs = then - now;
  if (deltaMs <= 0) return "due";
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

/** Truncates the middle with an ellipsis, keeping head and tail readable — for paths and URLs. */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return "…".slice(0, width);
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ""}`;
}
