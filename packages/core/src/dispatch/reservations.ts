/**
 * Dispatch-id reservations (SPEC §11, §17.4).
 *
 * The loop mints every dispatch id, because its bookkeeping, its WIP caps and
 * — decisively — the reaper's orphan-lock classification all compare the id it
 * tracks against the id the agent writes into the Linear lock comment. If the
 * two ever diverge, the reaper reads a live lock as orphaned and marks a
 * working issue blocked.
 *
 * With one agent session per dispatch, one `FOREMAN_DISPATCH_ID` in the child's
 * environment was enough. A stage's shared orchestrator serves many items
 * across many turns, so the id cannot live in the session environment: the loop
 * writes one reservation per item to a file the session's task guard reads,
 * keyed by the subject the slash command names. The model never transcribes an
 * id — it only writes the `FOREMAN-ISSUE`/`FOREMAN-PROJECT` marker it already
 * writes today, and the guard resolves the id from that.
 *
 * Reservations are consumed on use and pruned by TTL, so a subject dispatched
 * again later never picks up a leftover id from an abandoned run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Absolute path to the reservations file, handed to every dispatched session. */
export const RESERVATIONS_ENV = "FOREMAN_DISPATCH_RESERVATIONS";

export interface DispatchReservation {
  /** The `foreman-*` agent this reservation is for. */
  agent: string;
  /** Issue identifier, project id, or `batch` — what the slash command names. */
  subject: string;
  dispatchId: string;
  /** ISO timestamp; a reservation older than the caller's TTL is pruned unused. */
  reservedAt: string;
}

/** One file per agent, since a stage's orchestrator is the unit that reads it. */
export function reservationsPath(dir: string, agent: string): string {
  return join(dir, `${agent}.json`);
}

function isReservation(value: unknown): value is DispatchReservation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.agent === "string" &&
    typeof record.subject === "string" &&
    typeof record.dispatchId === "string" &&
    typeof record.reservedAt === "string"
  );
}

/**
 * Never throws: a missing, truncated or hand-edited file means "no
 * reservation", and the guard's own fallback (the inherited id, else a fresh
 * one) still produces a working dispatch — one the loop merely does not track.
 * Losing tracking is a recoverable annoyance; refusing to dispatch is not.
 */
export function readReservations(path: string): DispatchReservation[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReservation);
  } catch {
    return [];
  }
}

/** Temp-and-rename, so a reader never sees a half-written array. */
function saveReservations(path: string, entries: readonly DispatchReservation[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (entries.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function fresh(entry: DispatchReservation, now: Date, ttlMs: number): boolean {
  const age = now.getTime() - Date.parse(entry.reservedAt);
  return Number.isFinite(age) && age < ttlMs;
}

/**
 * Records the ids the loop just minted for one batch. A second reservation for
 * the same agent and subject replaces the first: the newer dispatch is the one
 * the loop is tracking, and leaving the stale id behind would let the guard
 * attach a lock comment to an id nothing is watching.
 */
export function reserveDispatches(
  path: string,
  entries: readonly DispatchReservation[],
  now: Date,
  ttlMs: number,
): void {
  const incoming = new Set(entries.map((entry) => `${entry.agent}\u0000${entry.subject}`));
  const kept = readReservations(path).filter(
    (entry) => fresh(entry, now, ttlMs) && !incoming.has(`${entry.agent}\u0000${entry.subject}`),
  );
  saveReservations(path, [...kept, ...entries]);
}

/**
 * Consumes the reservation for one item, pruning anything past TTL while it is
 * here. Returns `null` when nothing is reserved, which is the operator-dispatch
 * case: the guard falls back to the inherited id, then to minting one.
 */
export function takeReservation(
  path: string,
  agent: string,
  subject: string,
  now: Date,
  ttlMs: number,
): string | null {
  const entries = readReservations(path);
  if (entries.length === 0) return null;
  const index = entries.findIndex(
    (entry) => entry.agent === agent && entry.subject === subject && fresh(entry, now, ttlMs),
  );
  const taken = index >= 0 ? entries[index] : undefined;
  const remaining = entries.filter(
    (entry, at) => at !== index && fresh(entry, now, ttlMs),
  );
  if (remaining.length !== entries.length) saveReservations(path, remaining);
  return taken?.dispatchId ?? null;
}
