/**
 * Plan worker (SPEC §7.6, §17.5): decomposes a bare project — in scope, not
 * the standing Maintenance project, zero issues in any state — into its
 * first slate of Backlog issues. Once `foreman-plan` creates one issue the
 * project drops out of `planCandidates` on its own; there is no separate
 * "fully planned" flag to maintain (see `routing.ts`'s `routePlan`).
 */

import { BLOCKED_HUMAN_FILTER, MAINTENANCE_PROJECT_NAME, inProject, newDispatchId } from "@foreman/core";
import type { BoardSnapshot, DispatchDecision, PlanCandidate } from "../routing.ts";
import { nextActions } from "../routing.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function findPlanCandidates(ctx: WorkerContext): Promise<PlanCandidate[]> {
  const candidates: PlanCandidate[] = [];
  for (const initiativeId of ctx.entry.initiativeIds) {
    const projects = await ctx.linear.initiativeProjects(initiativeId);
    for (const project of projects) {
      if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;
      const issues = await ctx.linear.issues({ filter: inProject(project.id), limit: 1 });
      if (issues.length === 0) candidates.push({ project });
    }
  }
  return candidates;
}

async function runPlan(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const dispatched: DispatchDecision[] = [];

  const [planCandidates, blockedHuman] = await Promise.all([
    findPlanCandidates(ctx),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, limit: 500 }),
  ]);

  const snapshot: BoardSnapshot = {
    backlog: [],
    todo: [],
    reviewCandidates: [],
    blockedHumanCount: blockedHuman.length,
    readyBufferCount: 0,
    planCandidates,
  };

  const { decisions, skipped } = nextActions(snapshot, ctx.config, ctx.bookkeeping);
  if (ctx.dispatchPermitted) {
    for (const decision of decisions) {
      if (decision.agent !== "foreman-plan" || !decision.projectId) continue;
      const dispatchId = newDispatchId(decision.agent, decision.projectId, now);
      try {
        const handle = await ctx.dispatcher.dispatch({
          agent: decision.agent,
          issueId: null,
          command: decision.command,
          dispatchId,
          cwd: ctx.entry.repoPath,
        });
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: null,
          projectId: decision.projectId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "plan",
        });
        ctx.watchSettle(handle, "plan");
        dispatched.push(decision);
      } catch (error) {
        errors.push(`dispatch ${decision.command} failed: ${String(error)}`);
      }
    }
  }

  ctx.bookkeeping.setLastRun("plan", now);
  return {
    worker: "plan",
    ranAt: now.toISOString(),
    decisions,
    dispatched,
    skipped,
    errors,
    counts: { blocked: blockedHuman.length },
  };
}

export const planWorker: Worker = {
  name: "plan",
  cadenceMs: 5 * 60_000,
  run: runPlan,
};
