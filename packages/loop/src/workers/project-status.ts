/**
 * Project status worker (SPEC §7.6a, §17.5): keeps Linear's native project
 * status in sync with issue state, so status is read off the board rather
 * than inferred by looking. Deterministic, no agent, no dispatch — the same
 * class of housekeeping pass as the reaper (§11), not a `nextActions` stage.
 */

import { MAINTENANCE_PROJECT_NAME, inProject } from "@foreman/core";
import { nextProjectStatus } from "../project-status.ts";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function runProjectStatus(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];

  for (const initiativeId of ctx.entry.initiativeIds) {
    const projects = await ctx.linear.initiativeProjects(initiativeId);
    for (const project of projects) {
      if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;

      try {
        const [status, issues] = await Promise.all([
          ctx.linear.projectStatus(project.id),
          ctx.linear.issues({ filter: inProject(project.id), limit: 500 }),
        ]);
        if (!status) continue;

        const next = nextProjectStatus(
          status.type,
          issues.map((issue) => issue.state.type),
        );
        // Native project-status transitions are workflow mutations, not the
        // comments/labels permitted by the read-only rung.
        if (next && !ctx.dryRun && ctx.config.loop.stage !== "read-only") {
          await ctx.linear.updateProjectStatus({ projectId: project.id, type: next });
        }
      } catch (error) {
        errors.push(`project-status failed on "${project.name}": ${String(error)}`);
      }
    }
  }

  return { worker: "project-status", ranAt: now.toISOString(), dispatched: [], skipped: [], errors };
}

export const projectStatusWorker: Worker = {
  name: "project-status",
  cadenceMs: 5 * 60_000,
  run: runProjectStatus,
};
