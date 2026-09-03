/**
 * Project dependency predicates (SPEC §4.10a) — the project-level mirror of
 * `issue.ts`.
 *
 * Linear models a project dependency as a `ProjectRelation` of type
 * `dependency` anchored `end` -> `start`: the source project's finish gates
 * the target project's start. Read from the target, that edge is "blocked
 * by"; read from the source it is "blocks". The other anchor pairs Linear
 * permits (`start`/`start`, `end`/`end`) express alignment rather than a
 * hard prerequisite and are deliberately not treated as blockers.
 */

import type { ProjectRelation, ProjectRef, ProjectStatus } from "./types.ts";

/**
 * True when a blocking project no longer blocks: it shipped or was
 * abandoned. A missing status is treated as unresolved rather than assumed
 * complete — a read that failed to populate it must not silently unblock the
 * project it gates.
 */
export function projectBlockerIsResolved(status: ProjectStatus | null | undefined): boolean {
  if (!status) return false;
  return status.type === "completed" || status.type === "canceled";
}

/** Edges where `other` must finish before this project starts. */
export function blockedByProjectRelations(relations: readonly ProjectRelation[]): ProjectRelation[] {
  return relations.filter(
    (relation) =>
      relation.type === "dependency" &&
      relation.direction === "incoming" &&
      relation.otherAnchor === "end" &&
      relation.anchor === "start",
  );
}

/** Edges where this project must finish before `other` starts. */
export function blockingProjectRelations(relations: readonly ProjectRelation[]): ProjectRelation[] {
  return relations.filter(
    (relation) =>
      relation.type === "dependency" &&
      relation.direction === "outgoing" &&
      relation.anchor === "end" &&
      relation.otherAnchor === "start",
  );
}

/**
 * Blockers that have not resolved yet — the plan gate's input (SPEC §17.5).
 * Linear's `ProjectFilter` can answer "has any dependency edge" but nothing
 * about the blocker's status, so completeness is evaluated here, in code,
 * exactly as `incompleteBlockers` does for issues.
 */
export function incompleteProjectBlockers(relations: readonly ProjectRelation[]): ProjectRelation[] {
  return blockedByProjectRelations(relations).filter(
    (relation) => !projectBlockerIsResolved(relation.other.status),
  );
}

/**
 * The latest `targetDate` among a set of projects, or null when none carry
 * one. The roadmap surface places a new project's `startDate` after its
 * prerequisites finish; that needs the last of them, not the first.
 */
export function latestTargetDate(projects: readonly ProjectRef[]): string | null {
  let latest: string | null = null;
  for (const project of projects) {
    const target = project.targetDate;
    if (!target) continue;
    if (latest === null || target > latest) latest = target;
  }
  return latest;
}
