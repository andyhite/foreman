/**
 * Lock protocol (SPEC §11).
 *
 * `agent:running` is the mutex; it can carry no structure, so the dispatch
 * ID, timestamp, TTL, and worktree ride in a `foreman:lock` comment marker
 * written in the same mutation as the label. The dispatcher claims — it
 * writes both the label and this comment before spawning; agents only ever
 * read it back to verify ownership (`verifyLockOwnership`). This module
 * classifies lock state; it never takes an action. The reaper that acts on
 * `orphaned` locks lives elsewhere and never deletes a worktree (SPEC §11).
 */

import { encodeMarker, latestMarker, MARKER_KIND } from "./markers.ts";
import type { FoundMarker, MarkerSource } from "./markers.ts";
import type { GateResult } from "./gates/types.ts";

export interface LockRecord {
  dispatchId: string;
  agent: string;
  issueId: string;
  takenAt: string;
  ttlMs: number;
  worktree: string | null;
  released: boolean;
  releasedAt: string | null;
}

/**
 * Collision-resistant and greppable: an operator scanning comments can read
 * off the agent and issue at a glance, and the trailing random suffix keeps
 * two claims taken in the same millisecond apart.
 */
export function newDispatchId(agent: string, issueId: string, now: Date = new Date()): string {
  const compact = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${agent}-${issueId}-${compact}-${suffix}`;
}

/**
 * The issue identifier `newDispatchId` embedded, or null when `dispatchId`
 * is not one of ours.
 */
export function issueIdFromDispatchId(dispatchId: string): string | null {
  return /^foreman-[a-z]+-(\S+)-\d{8}T\d{6}Z-\w+$/.exec(dispatchId)?.[1] ?? null;
}

export function renderLockComment(record: LockRecord): string {
  const expires = new Date(new Date(record.takenAt).getTime() + record.ttlMs).toISOString();
  const human = [
    `Locked by \`${record.agent}\` (dispatch \`${record.dispatchId}\`).`,
    `Taken at ${record.takenAt}, expires ${expires}.`,
    record.worktree ? `Worktree: \`${record.worktree}\`.` : "No worktree.",
  ].join("\n");
  return encodeMarker(MARKER_KIND.lock, record, human);
}

export function readLockComment(comments: readonly MarkerSource[]): FoundMarker<LockRecord> | null {
  return latestMarker<LockRecord>(MARKER_KIND.lock, comments);
}

export interface LockState {
  held: boolean;
  expired: boolean;
  orphaned: boolean;
  reason: string;
}

export interface LockStateOptions {
  now: Date;
  /** Dispatch IDs known live: omp's process-global registry union the loop's bookkeeping (SPEC §11). */
  liveDispatchIds: readonly string[];
}

/**
 * Classify a lock. `orphaned` requires all three of: unreleased, past its
 * TTL, and cross-referenced against both liveness sources — the TTL alone
 * never proves a lock abandoned, only that it has run long (SPEC §11).
 */
export function lockState(record: LockRecord | null, options: LockStateOptions): LockState {
  if (record === null) {
    return { held: false, expired: false, orphaned: false, reason: "No lock comment found." };
  }

  if (record.released) {
    return { held: false, expired: false, orphaned: false, reason: "Lock was released." };
  }

  const expiresAt = new Date(record.takenAt).getTime() + record.ttlMs;
  // A malformed/absent `takenAt` or `ttlMs` makes `expiresAt` NaN, and
  // `now > NaN` is always false — treating the lock as held forever, the
  // exact failure mode the orphan classification exists to prevent.
  const expired = !Number.isFinite(expiresAt) || options.now.getTime() > expiresAt;

  if (!expired) {
    return { held: true, expired: false, orphaned: false, reason: "Lock is held and within TTL." };
  }

  const isLive = options.liveDispatchIds.includes(record.dispatchId);
  if (isLive) {
    return {
      held: true,
      expired: true,
      orphaned: false,
      reason: "Lock is past TTL but its dispatch ID is still live.",
    };
  }

  return {
    held: true,
    expired: true,
    orphaned: true,
    reason: "Lock is past TTL and its dispatch ID appears in no liveness source.",
  };
}

/** What `foreman-implement` step 1 checks before doing any work (SPEC §7.3, §11). */
export function verifyLockOwnership(record: LockRecord | null, dispatchId: string): GateResult {
  if (record === null) {
    return {
      ok: false,
      failures: [{ code: "no-lock", message: "No lock comment found for this issue." }],
    };
  }

  if (record.released) {
    return {
      ok: false,
      failures: [{ code: "lock-released", message: "Lock has already been released." }],
    };
  }

  if (record.dispatchId !== dispatchId) {
    return {
      ok: false,
      failures: [
        {
          code: "dispatch-id-mismatch",
          message: `Lock is held by dispatch \`${record.dispatchId}\`, not \`${dispatchId}\`.`,
        },
      ],
    };
  }

  return { ok: true, failures: [] };
}
