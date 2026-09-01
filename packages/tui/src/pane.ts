/**
 * Per-loop display helpers shared by the header and every data view.
 *
 * Connection state and snapshot freshness are easy to disagree on — the store
 * may still hold a last-known snapshot while `connection` is `offline` unless
 * explicitly cleared, and `file` snapshots are intentionally shown but must
 * never look live. These helpers are the single gate every view uses so an
 * operator never sees a stopped loop painted as running.
 */

import type { LoopSnapshot } from "@foreman/core";
import type { LoopPane } from "./store.ts";
import { relativeTime } from "./format.ts";

/** Below this width, list/detail panes stack vertically instead of side-by-side. */
export const LIST_DETAIL_STACK_WIDTH = 100;

/** Snapshot safe to render as operational data (may still be file-backed / stale). */
export function displaySnapshot(pane: LoopPane): LoopSnapshot | null {
  if (pane.connection === "offline" || pane.connection === "connecting") return null;
  return pane.snapshot;
}

export function isFileBacked(pane: LoopPane): boolean {
  return pane.connection === "file";
}

export function snapshotAge(pane: LoopPane, now: number): string | null {
  const tick = pane.snapshot?.runtime.lastTickAt;
  if (!tick) return null;
  return relativeTime(tick, now);
}

/** Compact connection label for the header chip. */
export function connectionChip(pane: LoopPane, now: number): string {
  switch (pane.connection) {
    case "live":
      return "live";
    case "file": {
      const age = snapshotAge(pane, now);
      return age ? `file · ${age}` : "file";
    }
    case "connecting":
      return "connecting";
    case "error":
      return "error";
    case "offline":
      return pane.error ? "offline · stale" : "offline";
  }
}

/** Watermark line for views still showing a file-backed snapshot. */
export function staleWatermark(pane: LoopPane, now: number): string | null {
  if (!isFileBacked(pane) || !pane.snapshot) return null;
  const age = snapshotAge(pane, now);
  return age ? `stale snapshot · last tick ${age} ago` : "stale snapshot · status.json";
}

/** Idle-state copy for overview and empty views. */
export function paneIdleMessage(pane: LoopPane): { line1: string; line2?: string } {
  if (!pane.handle.running) {
    return { line1: "process not running", line2: "press s to start" };
  }
  if (pane.connection === "connecting") {
    return { line1: "reconnecting…" };
  }
  if (pane.connection === "offline") {
    if (pane.error) {
      return { line1: pane.error, line2: "press s to start or r to refresh" };
    }
    return { line1: "disconnected — no status", line2: "press s to start" };
  }
  if (!pane.snapshot) {
    return { line1: "waiting for snapshot…" };
  }
  return { line1: "not running" };
}
