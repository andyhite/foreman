/**
 * Project status transitions (SPEC §7.6a): the pure predicate the
 * `project-status` worker applies. Mirrors `routing.ts`'s shape — no network
 * access, no model call, a plain function over already-fetched state.
 *
 * Deliberately restrained: only the two directions with no reasonable
 * disagreement are automated.
 *
 * - `started` the moment any issue is active or done — unambiguous, someone
 *   is working on it.
 * - `completed` once every issue is terminal (done or canceled) and at least
 *   one shipped — a project that only ever produced canceled issues is not
 *   "complete", it is abandoned, which is a judgment call left to the
 *   operator (`paused` and `canceled` are exclusively human-set and never
 *   read here as *decision inputs* the way `backlog`/`planned`/`started`
 *   are — see the guard below).
 *
 * `paused` and `canceled` are the operator's calls and are never advanced
 * automatically in either direction once set.
 */

import type { ProjectStatusType, WorkflowStateType } from "@foreman/core";

export function nextProjectStatus(
  current: ProjectStatusType,
  issueStateTypes: readonly WorkflowStateType[],
): ProjectStatusType | null {
  if (current === "paused" || current === "canceled" || current === "completed") return null;
  if (issueStateTypes.length === 0) return null;

  const allTerminal = issueStateTypes.every((type) => type === "completed" || type === "canceled");
  const hasCompleted = issueStateTypes.some((type) => type === "completed");
  if (allTerminal && hasCompleted) return "completed";

  if (current === "started") return null;

  const hasActiveOrDone = issueStateTypes.some((type) => type === "started" || type === "completed");
  if (hasActiveOrDone) return "started";

  return null;
}
