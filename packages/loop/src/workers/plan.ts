/**
 * Plan worker (SPEC §7.6, §17.5): decomposes a bare project — in scope, not
 * the standing Maintenance project, zero issues in any state — into its
 * first slate of Backlog issues. Once `foreman-plan` creates one issue the
 * project drops out of `planCandidates` on its own; there is no separate
 * "fully planned" flag to maintain (see `routing.ts`'s `routePlan`).
 */

import {
  BLOCKED_HUMAN_FILTER,
  DISPATCH_COMMAND,
  MAINTENANCE_PROJECT_NAME,
  incompleteProjectBlockers,
  inInitiatives,
  isTerminalProjectStatus,
  newDispatchId,
  type DispatchItem,
} from "@foreman/core";
import { isOrchestratorBusy } from "../dispatch/index.ts";
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
    ctx.linear.issues({ filter: inInitiatives(initiativeIds), first: 250 }),
  ]);
  const projectsWithIssues = new Set(
    issuesInScope.map((issue) => issue.project?.id).filter((id): id is string => id != null),
  );

  const bareProjects: { project: (typeof projectLists)[number][number] }[] = [];
  const seen = new Set<string>();
  for (const projects of projectLists) {
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;
      // `canceled` is terminal too: an abandoned bare project must not be
      // decomposed into a slate of Backlog issues nobody will work.
      // `paused` stays unread here deliberately (SPEC §7.6a) — it's the
      // operator's reversible hold, not something this gate should preempt.
      if (isTerminalProjectStatus(project.status)) continue;
      if (!projectsWithIssues.has(project.id)) bareProjects.push({ project });
    }
  }

  // Fetched per bare project rather than folded into the `initiativeProjects`
  // query above: nesting a relations connection under every project of every
  // initiative in one request trips Linear's query-complexity ceiling. The
  // fan-out here is bounded by the number of projects with zero issues —
  // typically a handful per tick — not by the initiative's full project
  // count, so the extra round trips are cheap.
  const relationsByProject = await Promise.all(
    bareProjects.map((candidate) => ctx.linear.projectRelations(candidate.project.id)),
  );
  const candidates: PlanCandidate[] = bareProjects.map((candidate, index) => ({
    project: candidate.project,
    blockedBy: incompleteProjectBlockers(relationsByProject[index] ?? []),
  }));
  return candidates;
}

async function runPlan(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const dispatched: DispatchDecision[] = [];

  const [planCandidates, blockedHuman] = await Promise.all([
    findPlanCandidates(ctx),
    ctx.linear.issues({ filter: BLOCKED_HUMAN_FILTER, first: 250 }),
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
  const confirmed: DispatchDecision[] = [];
  for (const decision of decisions) {
    if (decision.agent !== "foreman-plan" || !decision.projectId) continue;
    const project = planCandidates.find((candidate) => candidate.project.id === decision.projectId)?.project;
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
    confirmed.push(decision);
  }

  if (confirmed.length > 0) {
    const items: DispatchItem[] = confirmed.map((decision) => ({
      issueId: null,
      subject: decision.subject,
      dispatchId: newDispatchId(decision.agent, decision.subject ?? "batch", now),
      worktree: null,
    }));
    try {
      const handles = await ctx.dispatcher.dispatch({
        agent: "foreman-plan",
        command: DISPATCH_COMMAND.plan,
        cwd: ctx.entry.repoPath,
        alias: ctx.entry.alias,
        items,
      });
      handles.forEach((handle, index) => {
        const decision = confirmed[index];
        if (!decision) return;
        ctx.bookkeeping.recordDispatch({
          agent: decision.agent,
          issueId: null,
          projectId: decision.projectId,
          dispatchId: handle.dispatchId,
          startedAt: handle.startedAt,
          stage: "plan",
        });
        dispatched.push(decision);
      });
      ctx.watchSettle(handles, "plan");
    } catch (error) {
      if (isOrchestratorBusy(error)) {
        for (const decision of confirmed) {
          skipped.push({
            stage: "plan",
            issueId: null,
            projectId: decision.projectId,
            code: "orchestrator-busy",
            message: `foreman-plan orchestrator is busy: ${error.message}`,
          });
        }
      } else {
        errors.push(`dispatch ${DISPATCH_COMMAND.plan} failed: ${String(error)}`);
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
