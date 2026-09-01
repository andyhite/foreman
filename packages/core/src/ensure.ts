/**
 * The ensure pass (SPEC §3.11): on loop instance start and extension
 * `session_start`, every initiative bound to an instance must exist and have
 * its standing `Maintenance` project, so refine/implement always have a
 * project to file work under without a first-run "which project" prompt.
 *
 * Split from `packages/loop/src/main.ts` and the extension so both consumers
 * run the identical check — the whole point of a shared `core` package
 * (SPEC §3.1).
 */

import { ConfigError } from "./config/load.ts";
import type { Confirmer } from "./confirm.ts";
import type { LinearId } from "./linear/types.ts";
import type { LinearWriter } from "./linear/api.ts";

export const MAINTENANCE_PROJECT_NAME = "Maintenance";

export interface EnsureReport {
  initiativeId: string;
  initiativeName: string;
  /** Null only when the operator declined the create-project confirmation for an initiative that has no Maintenance project yet. */
  projectId: string | null;
  created: boolean;
}

/**
 * Ensures every initiative in `initiativeIds` exists and has a `Maintenance`
 * project, creating one (team-assigned, per `LinearWriter.createProject`'s
 * contract — SPEC §16 item 10) when absent.
 *
 * An initiative id that does not resolve is a config error, not a skip: the
 * registry binds *ids*, not names, specifically so a rename can't silently
 * break the binding (SPEC §3.5 item 6), which means an unresolvable id here
 * is the registry pointing at nothing — that must fail loudly before any
 * spawn (SPEC §3.11), not be swallowed as "nothing to ensure."
 *
 * `confirmer` (SPEC §17.9): creating the Maintenance project is a Linear
 * mutation, so it goes through `Confirmer.confirm` first. Every initiative
 * still resolves and every existing Maintenance project is still reported;
 * when the operator declines (or `confirmer` is `YOLO_CONFIRMER`, which
 * never declines), a missing one is reported with `projectId: null` and
 * `created: false` instead of being created — the caller logs that as
 * "declined" or "would create" and moves on.
 */
export async function ensureMaintenanceProjects(
  linear: LinearWriter,
  input: { initiativeIds: readonly string[]; teamId: LinearId; confirmer: Confirmer },
): Promise<EnsureReport[]> {
  const reports: EnsureReport[] = [];

  for (const initiativeId of input.initiativeIds) {
    const initiative = await linear.initiative(initiativeId);
    if (!initiative) {
      throw new ConfigError(
        `Bound initiative "${initiativeId}" does not exist in Linear`,
        [
          "the registry binds initiatives by id (SPEC §3.10) — check the id in the repo's",
          `"initiatives" list against the workspace, or remove the stale binding`,
        ],
      );
    }

    const projects = await linear.initiativeProjects(initiativeId);
    const existing = projects.find(
      (project) => project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase(),
    );
    if (existing) {
      reports.push({
        initiativeId,
        initiativeName: initiative.name,
        projectId: existing.id,
        created: false,
      });
      continue;
    }

    const proceed = await input.confirmer.confirm({
      kind: "linear-write",
      summary: `create the Maintenance project under initiative ${initiative.name}`,
    });
    if (!proceed) {
      reports.push({
        initiativeId,
        initiativeName: initiative.name,
        projectId: null,
        created: false,
      });
      continue;
    }

    const project = await linear.createProject({
      name: MAINTENANCE_PROJECT_NAME,
      teamIds: [input.teamId],
    });
    // `createProject` and `addProjectToInitiative` are unavoidably two calls
    // (SPEC §16 item 10, measured: `ProjectCreateInput` has no
    // `initiativeId` field). If the second call fails, `project` now exists
    // attached to no initiative. A later run cannot safely adopt it by name
    // match — project names are not unique across initiatives, so finding a
    // project named "Maintenance" elsewhere proves nothing about which
    // initiative it belongs to. So: fail loudly, name the orphan's id in the
    // message, and let the operator link or delete it by hand rather than
    // risk silently binding the wrong project to an initiative.
    try {
      await linear.addProjectToInitiative({ projectId: project.id, initiativeId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `created Maintenance project ${project.id} for initiative "${initiative.name}" ` +
          `(${initiativeId}) but failed to attach it: ${reason} — the project exists but is ` +
          `unattached; link it to the initiative or delete it by hand`,
      );
    }

    reports.push({
      initiativeId,
      initiativeName: initiative.name,
      projectId: project.id,
      created: true,
    });
  }

  return reports;
}
