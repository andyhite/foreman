/**
 * Refine worker (SPEC §17.5): keeps the Ready buffer stocked to
 * `loop.readyBufferTarget`. Selects Backlog issues, plus `legacy` issues
 * sitting in Backlog or Todo (SPEC §4.9), scoped to this instance (SPEC §3.11).
 */

import {
  BLOCKED_HUMAN_FILTER,
  DISPATCH_COMMAND,
  LEGACY_LABEL,
  hasLabel,
  inState,
  newDispatchId,
  readyFilter,
  type DispatchItem,
} from "@foreman/core";
import { isOrchestratorBusy } from "../dispatch/index.ts";
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
  const confirmed: DispatchDecision[] = [];
  for (const decision of decisions) {
    if (!decision.issueId) continue;
    const issue = backlog.find((candidate) => candidate.identifier === decision.issueId);
    if (!issue) continue;
    const summary = `dispatch ${decision.agent} for ${decision.issueId}`;
    if (!(await ctx.confirm({ kind: "dispatch", summary, detail: [`command: ${decision.command}`, `cwd: ${ctx.entry.repoPath}`] }))) {
      skipped.push({ stage: "refine", issueId: decision.issueId, code: "dispatch-declined", message: `Operator declined: ${summary}` });
      continue;
    }
    confirmed.push(decision);
  }

  if (confirmed.length > 0) {
    const items: DispatchItem[] = confirmed.map((decision) => ({
      issueId: decision.issueId,
      subject: decision.subject,
      dispatchId: newDispatchId(decision.agent, decision.subject ?? "batch", now),
      worktree: null,
    }));
    try {
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-refine",
        command: DISPATCH_COMMAND.refine,
        cwd: ctx.entry.repoPath,
        alias: ctx.entry.alias,
        items,
      });
      handles.forEach((handle, index) => {
        const decision = confirmed[index];
        if (!decision) return;
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: decision.issueId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "refine",
        });
        dispatched.push(decision);
      });
      ctx.watchSettle(handles, "refine");
    } catch (error) {
      if (isOrchestratorBusy(error)) {
        for (const decision of confirmed) {
          skipped.push({
            stage: "refine",
            issueId: decision.issueId,
            code: "orchestrator-busy",
            message: `foreman-refine orchestrator is busy: ${error.message}`,
          });
        }
      } else {
        errors.push(`dispatch ${DISPATCH_COMMAND.refine} failed: ${String(error)}`);
      }
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
