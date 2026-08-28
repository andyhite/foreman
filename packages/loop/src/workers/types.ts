/**
 * Worker contract (SPEC §17.5): one supervisor process, several independent
 * workers, each owning exactly one transition and evaluating only its own
 * predicate by calling into `routing.ts` rather than re-deriving selection.
 */

import type { Dispatcher, GlobalConfig, LinearWriter } from "@foreman/core";
import type { Bookkeeping } from "../bookkeeping.ts";
import type { DispatchDecision, SkipRecord, StageName } from "../routing.ts";

export interface WorkerReport {
  worker: StageName | "reaper" | "merge-detect";
  ranAt: string;
  dispatched: DispatchDecision[];
  skipped: SkipRecord[];
  errors: string[];
}

export interface WorkerContext {
  config: GlobalConfig;
  bookkeeping: Bookkeeping;
  dispatcher: Dispatcher;
  linear: LinearWriter;
  /** Injectable clock, so tests never depend on wall time. */
  now: () => Date;
  log: (message: string) => void;
  /** Dry-run: decisions are computed and logged, never dispatched or written. */
  dryRun: boolean;
}

export interface Worker {
  name: string;
  cadenceMs: number;
  run(ctx: WorkerContext): Promise<WorkerReport>;
}
