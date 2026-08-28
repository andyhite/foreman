/**
 * Triage worker (SPEC §17.5): batch dispatch of `foreman-triage` over the
 * Inbox view, once per day at `loop.triageWindow`.
 */

import {
  BLOCKED_HUMAN_FILTER,
  INBOX_FILTER,
  PROPOSALS_FILTER,
  expandHome,
  newDispatchId,
} from "@foreman/core";
import type { BoardSnapshot } from "../routing.ts";
import { nextActions } from "../routing.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function runTriage(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];

  const [inbox, blockedHuman, proposed] = await Promise.all([
    ctx.linear.issues({ filter: INBOX_FILTER, limit: ctx.config.triage.batchSize }),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
    ctx.linear.issues({ filter: PROPOSALS_FILTER, limit: 500 }),
  ]);

  const snapshot: BoardSnapshot = {
    inbox,
    backlog: [],
    todo: [],
    reviewCandidates: [],
    blockedHumanCount: blockedHuman.length,
    proposedCount: proposed.length,
    readyBufferCount: 0,
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping, now);

  if (!ctx.dryRun) {
    for (const decision of decisions) {
      const dispatchId = newDispatchId(decision.agent, "batch", now);
      const scratchCwd = `${expandHome(ctx.config.loop.stateDir)}/scratch`;
      try {
        const handle = await ctx.dispatcher.dispatch({
          agent: decision.agent,
          issueId: null,
          command: decision.command,
          dispatchId,
          cwd: scratchCwd,
        });
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: null,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "triage",
        });
        ctx.bookkeeping.setLastTriageRun(now);
      } catch (error) {
        errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
      }
    }
  }

  ctx.bookkeeping.setLastRun("triage", now);
  return { worker: "triage", ranAt: now.toISOString(), dispatched: decisions, skipped, errors };
}

export const triageWorker: Worker = {
  name: "triage",
  cadenceMs: 5 * 60_000,
  run: runTriage,
};
