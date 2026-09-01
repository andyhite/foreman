/**
 * Refine worker (SPEC §17.5): keeps the Ready buffer stocked to
 * `loop.readyBufferTarget`. Selects Backlog issues, plus `legacy` issues
 * sitting in Backlog or Todo (SPEC §4.9), scoped to this instance (SPEC §3.11).
 */

import {
  BLOCKED_HUMAN_FILTER,
  LEGACY_LABEL,
  hasLabel,
  inState,
  newDispatchId,
  readyFilter,
} from "@foreman/core";
import type { BoardSnapshot, DispatchDecision } from "../routing.ts";
import { nextActions } from "../routing.ts";
import { toQueueItem } from "../snapshot.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";
import { filterInScope } from "./types.ts";

async function runRefine(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const dispatched: DispatchDecision[] = [];

  const [backlogIssues, todoIssues, blockedHuman, ready] = await Promise.all([
    ctx.linear.issues({ filter: inState("Backlog"), limit: 500 }),
    ctx.linear.issues({ filter: inState("Todo"), limit: 500 }),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
    ctx.linear.issues({ filter: readyFilter(), limit: 500 }),
  ]);

  const legacyInTodo = todoIssues.filter((issue) => hasLabel(issue, LEGACY_LABEL));
  const [{ inScope: backlog, skipped: scopeSkips }, { inScope: scopedReady }] = await Promise.all([
    filterInScope(ctx, "refine", [...backlogIssues, ...legacyInTodo]),
    filterInScope(ctx, "refine", ready),
  ]);

  const snapshot: BoardSnapshot = {
    backlog,
    todo: [],
    reviewCandidates: [],
    blockedHumanCount: blockedHuman.length,
    readyBufferCount: scopedReady.length,
    planCandidates: [],
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping);
  skipped.push(...scopeSkips);
  for (const decision of decisions) {
    if (!decision.issueId) continue;
    const issue = backlog.find((candidate) => candidate.identifier === decision.issueId);
    if (!issue) continue;
    const dispatchId = newDispatchId(decision.agent, decision.issueId, now);
    const summary = `dispatch ${decision.agent} for ${decision.issueId}`;
    if (!(await ctx.confirm({ kind: "dispatch", summary, detail: [`command: ${decision.command}`, `cwd: ${ctx.entry.repoPath}`] }))) {
      skipped.push({ stage: "refine", issueId: decision.issueId, code: "dispatch-declined", message: `Operator declined: ${summary}` });
      continue;
    }
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
        stage: "refine",
      });
      ctx.watchSettle(handle, "refine");
      dispatched.push(decision);
    } catch (error) {
      errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
    }
  }

  ctx.bookkeeping.setLastRun("refine", now);
  return {
    worker: "refine",
    ranAt: now.toISOString(),
    decisions,
    dispatched,
    skipped,
    errors,
    counts: { backlog: backlog.length, readyBuffer: scopedReady.length, blocked: blockedHuman.length },
    queues: { pipeline: backlog.map(toQueueItem) },
  };
}

export const refineWorker: Worker = {
  name: "refine",
  cadenceMs: 5 * 60_000,
  run: runRefine,
};
