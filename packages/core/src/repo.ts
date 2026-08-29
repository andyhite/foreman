import { ConfigError } from "./config/load.ts";
import type { ResolvedRepoEntry } from "./config/load.ts";
import type { LinearReader } from "./linear/api.ts";
import type { Issue } from "./linear/types.ts";

/**
 * Why an issue is out of an instance's scope (SPEC §3.11). The loop skips on
 * any of these; a manual command refuses and names the reason.
 */
export type OutOfScopeReason =
  | "no-project"
  | "initiative-unbound"
  | "project-no-initiative"
  | "project-multiple-initiatives";

export interface ScopeVerdict {
  inScope: boolean;
  reason: OutOfScopeReason | null;
  /** The issue's resolved initiative, when it had one. */
  initiativeId: string | null;
  message: string | null;
}

/**
 * Decides whether `issue` belongs to this instance: its project's single
 * product initiative must be in the entry's bound set (SPEC §3.11).
 *
 * Team scoping is applied by the Linear client, so this checks only the
 * initiative half of the predicate. Returns a verdict rather than throwing —
 * out-of-scope is the *normal* case for a team with several repos, and the
 * loop must skip silently rather than treat it as an error.
 */
export async function issueScope(
  deps: { linear: Pick<LinearReader, "projectInitiatives">; entry: ResolvedRepoEntry },
  issue: Issue,
): Promise<ScopeVerdict> {
  if (issue.project === null) {
    return {
      inScope: false,
      reason: "no-project",
      initiativeId: null,
      message: `Issue ${issue.identifier} has no project, so it belongs to no initiative`,
    };
  }

  const initiatives = await deps.linear.projectInitiatives(issue.project.id);
  if (initiatives.length === 0) {
    return {
      inScope: false,
      reason: "project-no-initiative",
      initiativeId: null,
      message: `Issue ${issue.identifier}'s project has no initiative; a project must belong to exactly one initiative`,
    };
  }
  if (initiatives.length > 1) {
    return {
      inScope: false,
      reason: "project-multiple-initiatives",
      initiativeId: null,
      message: `Issue ${issue.identifier}'s project belongs to more than one initiative (${initiatives.map((node) => node.name).join(", ")}); a project must belong to exactly one initiative`,
    };
  }

  const initiative = initiatives[0];
  if (!initiative || !deps.entry.initiativeIds.includes(initiative.id)) {
    return {
      inScope: false,
      reason: "initiative-unbound",
      initiativeId: initiative?.id ?? null,
      message:
        `Issue ${issue.identifier} belongs to initiative "${initiative?.name}" (${initiative?.id}), ` +
        `which is not bound to repos.${deps.entry.alias}`,
    };
  }

  return { inScope: true, reason: null, initiativeId: initiative.id, message: null };
}

/**
 * `issueScope`, but for the manual commands (SPEC §3.11): an out-of-scope
 * issue is operator error there, not a routine skip, so it throws with the
 * reason rather than returning a verdict to ignore.
 */
export async function assertIssueInScope(
  deps: { linear: Pick<LinearReader, "projectInitiatives">; entry: ResolvedRepoEntry },
  issue: Issue,
): Promise<void> {
  const verdict = await issueScope(deps, issue);
  if (!verdict.inScope) {
    throw new ConfigError(verdict.message ?? `Issue ${issue.identifier} is out of scope`, [
      `repos.${deps.entry.alias} binds ${deps.entry.initiativeIds.join(", ") || "no initiatives"}`,
    ]);
  }
}
