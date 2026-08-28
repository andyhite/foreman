/**
 * Loop bookkeeping (SPEC §17.5, §17.8).
 *
 * Attempt counters, review-cycle counters, last-triage-run, `reviewedSha` per
 * PR, and dispatch history — a small JSON file in the loop's state dir.
 *
 * Explicitly **non-authoritative**: this file is dispatch bookkeeping, not
 * workflow state. Losing it costs at most one redundant dispatch (a stale
 * `inFlight` record that outlives the real spawn) or one premature retry (an
 * attempt counter reset to zero). Linear stays the single source of truth for
 * whether an issue actually advanced; the reaper reconciles this file against
 * Linear and the omp registry on every supervisor start (SPEC §11, §17.5).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ForemanAgentName } from "@foreman/core";
import type { StageName } from "./routing.ts";

export interface AttemptRecord {
  count: number;
  lastAttemptAt: string;
}

export interface DispatchRecordEntry {
  agent: ForemanAgentName;
  issueId: string | null;
  dispatchId: string;
  startedAt: string;
  stage: StageName;
}

export type DecisionKind = "retry-exhausted" | "review-cycle-exhausted";

export interface PendingDecision {
  issueId: string;
  stage: StageName;
  kind: DecisionKind;
  attempts: number;
  detectedAt: string;
}

export interface BookkeepingState {
  version: number;
  attempts: Record<string, AttemptRecord>;
  reviewCycles: Record<string, number>;
  lastTriageRunAt: string | null;
  reviewedSha: Record<string, string>;
  inFlight: DispatchRecordEntry[];
  pendingDecisions: PendingDecision[];
  /** Last time each stage worker completed a tick, for `/foreman-status` and the board. */
  lastRunAt: Record<StageName, string | null>;
}

const CURRENT_VERSION = 1;

export function emptyBookkeepingState(): BookkeepingState {
  return {
    version: CURRENT_VERSION,
    attempts: {},
    reviewCycles: {},
    lastTriageRunAt: null,
    reviewedSha: {},
    inFlight: [],
    pendingDecisions: [],
    lastRunAt: { triage: null, refine: null, implement: null, review: null },
  };
}

function attemptKey(stage: StageName, issueId: string): string {
  return `${stage}:${issueId}`;
}

/**
 * Loads, mutates, and atomically persists `<stateDir>/bookkeeping.json`.
 *
 * The write path is temp-file-then-rename within the same directory, so a
 * concurrent reader (the board, or a second worker tick) either sees the
 * previous complete file or the new complete file, never a half-written one
 * (SPEC §17.5).
 */
export class Bookkeeping {
  readonly #path: string;
  #state: BookkeepingState;

  private constructor(path: string, state: BookkeepingState) {
    this.#path = path;
    this.#state = state;
  }

  /** Loads from `path`; a missing file loads as an empty state rather than throwing. */
  static load(path: string): Bookkeeping {
    if (!existsSync(path)) {
      return new Bookkeeping(path, emptyBookkeepingState());
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BookkeepingState>;
    return new Bookkeeping(path, { ...emptyBookkeepingState(), ...parsed });
  }

  get state(): Readonly<BookkeepingState> {
    return this.#state;
  }

  save(): void {
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });
    const tempPath = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.#state, null, 2), "utf8");
    renameSync(tempPath, this.#path);
  }

  // ---- in-flight dispatch tracking --------------------------------------

  recordDispatch(entry: DispatchRecordEntry): void {
    this.#state.inFlight.push(entry);
  }

  clearDispatch(dispatchId: string): void {
    this.#state.inFlight = this.#state.inFlight.filter((entry) => entry.dispatchId !== dispatchId);
  }

  countInFlight(stage: StageName): number {
    return this.#state.inFlight.filter((entry) => entry.stage === stage).length;
  }

  totalInFlight(): number {
    return this.#state.inFlight.length;
  }

  /**
   * Reconciles `inFlight` against Linear (SPEC §11, §17.5): drops any record
   * whose issue no longer carries `agent:running`, and any batch (triage)
   * record whose dispatch id is absent from the live omp registry. Called by
   * the supervisor on start; the worst case of skipping this is one
   * redundant dispatch, never corrupted Linear state.
   */
  reconcile(liveIssueIds: ReadonlySet<string>, liveDispatchIds: ReadonlySet<string>): void {
    this.#state.inFlight = this.#state.inFlight.filter((entry) => {
      if (entry.issueId) return liveIssueIds.has(entry.issueId);
      return liveDispatchIds.has(entry.dispatchId);
    });
  }

  // ---- retry / review-cycle counters (SPEC §17.8) -----------------------

  /**
   * Records a failed attempt for `stage`/`issueId`. Once the count exceeds
   * `retryCap`, appends (and returns) a `PendingDecision` the supervisor
   * converts into a `blocked:needs-decision` Linear write instead of
   * retrying again.
   */
  recordAttemptFailure(stage: StageName, issueId: string, retryCap: number, now: Date): PendingDecision | null {
    const key = attemptKey(stage, issueId);
    const existing = this.#state.attempts[key];
    const count = (existing?.count ?? 0) + 1;
    this.#state.attempts[key] = { count, lastAttemptAt: now.toISOString() };
    if (count <= retryCap) return null;
    const decision: PendingDecision = {
      issueId,
      stage,
      kind: "retry-exhausted",
      attempts: count,
      detectedAt: now.toISOString(),
    };
    this.#state.pendingDecisions.push(decision);
    return decision;
  }

  resetAttempts(stage: StageName, issueId: string): void {
    delete this.#state.attempts[attemptKey(stage, issueId)];
  }

  attemptCount(stage: StageName, issueId: string): number {
    return this.#state.attempts[attemptKey(stage, issueId)]?.count ?? 0;
  }

  /**
   * Records one review→fix cycle for `issueId` (SPEC §7.4). Once the count
   * exceeds `reviewCycleCap`, appends a `PendingDecision`.
   */
  recordReviewCycle(issueId: string, reviewCycleCap: number, now: Date): PendingDecision | null {
    const count = (this.#state.reviewCycles[issueId] ?? 0) + 1;
    this.#state.reviewCycles[issueId] = count;
    if (count <= reviewCycleCap) return null;
    const decision: PendingDecision = {
      issueId,
      stage: "review",
      kind: "review-cycle-exhausted",
      attempts: count,
      detectedAt: now.toISOString(),
    };
    this.#state.pendingDecisions.push(decision);
    return decision;
  }

  reviewCycleCount(issueId: string): number {
    return this.#state.reviewCycles[issueId] ?? 0;
  }

  resetReviewCycles(issueId: string): void {
    delete this.#state.reviewCycles[issueId];
  }

  drainPendingDecisions(): PendingDecision[] {
    const drained = this.#state.pendingDecisions;
    this.#state.pendingDecisions = [];
    return drained;
  }

  // ---- misc ---------------------------------------------------------------

  setLastTriageRun(now: Date): void {
    this.#state.lastTriageRunAt = now.toISOString();
  }

  setReviewedSha(issueId: string, sha: string): void {
    this.#state.reviewedSha[issueId] = sha;
  }

  reviewedSha(issueId: string): string | null {
    return this.#state.reviewedSha[issueId] ?? null;
  }

  setLastRun(stage: StageName, now: Date): void {
    this.#state.lastRunAt[stage] = now.toISOString();
  }
}

/** Removes the bookkeeping file entirely, e.g. for a clean-slate test fixture. */
export function deleteBookkeepingFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
