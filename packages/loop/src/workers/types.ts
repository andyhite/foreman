/**
 * Worker contract (SPEC §17.5): one supervisor process, several independent
 * workers, each owning exactly one transition and evaluating only its own
 * predicate by calling into `routing.ts` rather than re-deriving selection.
 */

import type { Dispatcher, GlobalConfig, Issue, LinearWriter, ResolvedRepoEntry } from "@foreman/core";
import { issueScope } from "@foreman/core";
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
  /** This instance's resolved registry entry (SPEC §3.11): repo path, team, bound initiatives, merged settings. */
  entry: ResolvedRepoEntry;
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

/**
 * Filters `issues` down to the ones in this instance's scope (SPEC §3.11):
 * their project's initiative must be bound to `ctx.entry`. Out-of-scope
 * issues never reach a worker's dispatch logic — they belong to another
 * instance, so this is a routine, silent skip, not an error.
 */
export async function filterInScope(
  ctx: WorkerContext,
  stage: StageName,
  issues: readonly Issue[],
): Promise<{ inScope: Issue[]; skipped: SkipRecord[] }> {
  const inScope: Issue[] = [];
  const skipped: SkipRecord[] = [];
  for (const issue of issues) {
    const verdict = await issueScope({ linear: ctx.linear, entry: ctx.entry }, issue);
    if (verdict.inScope) {
      inScope.push(issue);
    } else {
      skipped.push({
        stage,
        issueId: issue.identifier,
        code: "out-of-scope",
        message: verdict.message ?? `${issue.identifier} is out of scope for repos.${ctx.entry.alias}`,
      });
    }
  }
  return { inScope, skipped };
}
