/**
 * Plan worker (SPEC §7.6, §17.5): decomposes a bare project — in scope, not
 * the standing Maintenance project, zero issues in any state — into its
 * first slate of Backlog issues. Once `foreman-plan` creates one issue the
 * project drops out of `planCandidates` on its own; there is no separate
 * "fully planned" flag to maintain (see `routing.ts`'s `routePlan`).
 */

import { BLOCKED_HUMAN_FILTER, MAINTENANCE_PROJECT_NAME, inInitiatives, newDispatchId } from "@foreman/core";
import type { BoardSnapshot, DispatchDecision, PlanCandidate } from "../routing.ts";
import { nextActions } from "../routing.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

/**
 * A project is bare when it has zero issues in any state. Rather than ask
 * Linear once per project (SPEC §17.5 already scopes this loop to a handful
 * of initiatives, but a busy initiative can carry dozens of projects — that
 * many round trips per tick was the actual cost here), this fetches every
 * issue under the instance's initiatives in one query and checks project
 * membership in memory.
 */
async function findPlanCandidates(ctx: WorkerContext): Promise<PlanCandidate[]> {
  const initiativeIds = ctx.entry.initiativeIds;
  if (initiativeIds.length === 0) return [];

  const [projectLists, issuesInScope] = await Promise.all([
    Promise.all(initiativeIds.map((initiativeId) => ctx.linear.initiativeProjects(initiativeId))),
    ctx.linear.issues({ filter: inInitiatives(initiativeIds), limit: 500 }),
  ]);
  if (issuesInScope.length >= 500) {
    ctx.log(`plan: query returned a full page of 500 issues; some projects may look bare when they are not.`);
  }
  const projectsWithIssues = new Set(
    issuesInScope.map((issue) => issue.project?.id).filter((id): id is string => id != null),
  );

  const candidates: PlanCandidate[] = [];
  const seen = new Set<string>();
  for (const projects of projectLists) {
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;
      if (!projectsWithIssues.has(project.id)) candidates.push({ project });
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
  for (const decision of decisions) {
    if (decision.agent !== "foreman-plan" || !decision.projectId) continue;
    const project = planCandidates.find((candidate) => candidate.project.id === decision.projectId)?.project;
    const dispatchId = newDispatchId(decision.agent, decision.projectId, now);
    const summary = `dispatch ${decision.agent} for project ${project?.name ?? decision.projectId}`;
    if (!(await ctx.confirm({ kind: "dispatch", summary, detail: [`command: ${decision.command}`, `cwd: ${ctx.entry.repoPath}`] }))) {
      skipped.push({
        stage: "plan",
        issueId: null,
        projectId: decision.projectId,
        code: "dispatch-declined",
        message: `Operator declined: ${summary}`,
      });
      continue;
    }
    try {
      const handle = await ctx.dispatcher.dispatch({
        agent: decision.agent,
        issueId: null,
        command: decision.command,
        dispatchId,
        cwd: ctx.entry.repoPath,
        worktree: null,
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
