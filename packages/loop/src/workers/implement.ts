/**
 * Implement worker (SPEC §17.5): pulls from Todo issues that pass the
 * implementation gate. On a retry-cap-exhausted attempt (§17.8), converts
 * the counter into a `blocked:needs-decision` Linear write instead of
 * dispatching again.
 */

import {
  AGENT_LABEL,
  BLOCKED_HUMAN_FILTER,
  BLOCKED_LABEL,
  expandHome,
  inState,
  newDispatchId,
  repoForIssue,
} from "@foreman/core";
import type { BoardSnapshot } from "../routing.ts";
import { nextActions } from "../routing.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";
import { applyPendingDecisions } from "./decisions.ts";

async function runImplement(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];

  const [todo, blockedHuman] = await Promise.all([
    ctx.linear.issues({ filter: inState("Todo"), limit: 500 }),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
  ]);

  const snapshot: BoardSnapshot = {
    inbox: [],
    backlog: [],
    todo,
    reviewCandidates: [],
    blockedHumanCount: blockedHuman.length,
    proposedCount: 0,
    readyBufferCount: 0,
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping, now);

  if (!ctx.dryRun) {
    for (const decision of decisions) {
      if (!decision.issueId) continue;
      const issue = todo.find((candidate) => candidate.identifier === decision.issueId);
      if (!issue) continue;
      let cwd: string;
      if (issue.project === null) {
        cwd = `${expandHome(ctx.config.loop.stateDir)}/scratch`;
      } else {
        try {
          cwd = await repoForIssue({ linear: ctx.linear, config: ctx.config }, issue);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            stage: "implement",
            issueId: decision.issueId,
            code: "unresolved-repo",
            message,
          });
          continue;
        }
      }
      const dispatchId = newDispatchId(decision.agent, decision.issueId, now);
      try {
        const handle = await ctx.dispatcher.dispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          command: decision.command,
          dispatchId,
          cwd,
        });
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "implement",
        });
      } catch (error) {
        errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
        const pending = ctx.bookkeeping.recordAttemptFailure(
          "implement",
          decision.issueId,
          ctx.config.loop.retryCap,
          now,
        );
        if (pending) errors.push(...(await applyPendingDecisions(ctx, [pending])));
      }
    }
  }

  ctx.bookkeeping.setLastRun("implement", now);
  return { worker: "implement", ranAt: now.toISOString(), dispatched: decisions, skipped, errors };
}
export const implementWorker: Worker = {
  name: "implement",
  cadenceMs: 5 * 60_000,
  run: runImplement,
};
