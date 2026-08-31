/**
 * Implement worker (SPEC §17.5): pulls from Todo issues that pass the
 * implementation gate, scoped to this instance (SPEC §3.11). On a
 * retry-cap-exhausted attempt (§17.8), converts the counter into a
 * `blocked:needs-decision` Linear write instead of dispatching again.
 */

import {
  BLOCKED_HUMAN_FILTER,
  inState,
  newDispatchId,
} from "@foreman/core";
import { nextActions } from "../routing.ts";
import type { BoardSnapshot, DispatchDecision } from "../routing.ts";
import { toQueueItem } from "../snapshot.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";
import { filterInScope } from "./types.ts";
import { applyPendingDecisions } from "./decisions.ts";

async function runImplement(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const dispatched: DispatchDecision[] = [];

  const [todoIssues, blockedHuman] = await Promise.all([
    ctx.linear.issues({ filter: inState("Todo"), limit: 500 }),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
  ]);

  const { inScope: todo, skipped: scopeSkips } = await filterInScope(ctx, "implement", todoIssues);

  const snapshot: BoardSnapshot = {
    backlog: [],
    todo,
    reviewCandidates: [],
    blockedHumanCount: blockedHuman.length,
    readyBufferCount: 0,
    planCandidates: [],
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping);
  skipped.push(...scopeSkips);

  if (ctx.dispatchPermitted) {
    for (const decision of decisions) {
      if (!decision.issueId) continue;
      const issue = todo.find((candidate) => candidate.identifier === decision.issueId);
      if (!issue) continue;
      const dispatchId = newDispatchId(decision.agent, decision.issueId, now);
      try {
        const handle = await ctx.dispatcher.dispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          command: decision.command,
          dispatchId,
          cwd: ctx.entry.repoPath,
        });
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "implement",
        });
        ctx.watchSettle(handle, "implement");
        dispatched.push(decision);
        ctx.bookkeeping.resetAttempts("implement", decision.issueId);
      } catch (error) {
        errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
        const pending = ctx.bookkeeping.recordAttemptFailure(
          "implement",
          decision.issueId,
          ctx.config.loop.retryCap,
          now,
        );
        if (pending) {
          errors.push(...(await applyPendingDecisions(ctx, [pending])));
          ctx.bookkeeping.drainPendingDecisions();
        }
      }
    }
  }

  ctx.bookkeeping.setLastRun("implement", now);
  return {
    worker: "implement",
    ranAt: now.toISOString(),
    decisions,
    dispatched,
    skipped,
    errors,
    counts: { todo: todo.length, blocked: blockedHuman.length },
    queues: { pipeline: todo.map(toQueueItem) },
  };
}
export const implementWorker: Worker = {
  name: "implement",
  cadenceMs: 5 * 60_000,
  run: runImplement,
};
