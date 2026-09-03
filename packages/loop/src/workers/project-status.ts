/**
 * Project status worker (SPEC §7.6a, §17.5): keeps Linear's native project
 * status in sync with issue state, so status is read off the board rather
 * than inferred by looking. Deterministic, no agent, no dispatch — the same
 * class of housekeeping pass as the reaper (§11), not a `nextActions` stage.
 */

import { MAINTENANCE_PROJECT_NAME, inInitiatives } from "@foreman/core";
import type { WorkflowStateType } from "@foreman/core";
import { nextProjectStatus } from "../project-status.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function runProjectStatus(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const initiativeIds = ctx.entry.initiativeIds;

  const [projectLists, issuesInScope] = await Promise.all([
    Promise.all(initiativeIds.map((initiativeId) => ctx.linear.initiativeProjects(initiativeId))),
    initiativeIds.length === 0 ? Promise.resolve([]) : ctx.linear.issues({ filter: inInitiatives(initiativeIds), first: 250 }),
  ]);
  const issuesByProject = new Map<string, WorkflowStateType[]>();
  for (const issue of issuesInScope) {
    if (!issue.project) continue;
    const states = issuesByProject.get(issue.project.id) ?? [];
    states.push(issue.state.type);
    issuesByProject.set(issue.project.id, states);
  }

  const seen = new Set<string>();
  for (const projects of projectLists) {
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;

      try {
        const status = project.status;
        if (!status) continue;

        const next = nextProjectStatus(status.type, issuesByProject.get(project.id) ?? []);
        // Native project-status transitions are Linear writes, gated the
        // same as any other action outside this process (SPEC §17.9).
        if (next && (await ctx.confirm({ kind: "linear-write", summary: `set project ${project.name} status to ${next}` }))) {
          await ctx.linear.updateProjectStatus({ projectId: project.id, type: next });
        }
      } catch (error) {
        errors.push(`project-status failed on "${project.name}": ${String(error)}`);
      }
    }
  }

  return { worker: "project-status", ranAt: now.toISOString(), decisions: [], dispatched: [], skipped: [], errors };
}

export const projectStatusWorker: Worker = {
  name: "project-status",
  cadenceMs: 5 * 60_000,
  run: runProjectStatus,
};
