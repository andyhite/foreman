/**
 * Workflow states (SPEC §4.2). Linear's native set; no custom states.
 *
 * State *names* are workspace-defined, so nothing resolves a state by name
 * alone: `resolveState` matches a Foreman state to a real team state by name
 * first and by category second, and a workspace missing `Duplicate` falls back
 * to its canceled state plus a duplicate relation.
 */

import type { WorkflowState, WorkflowStateType } from "../linear/types.ts";

export const FOREMAN_STATE = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  inProgress: "In Progress",
  inReview: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const;

export type ForemanStateKey = keyof typeof FOREMAN_STATE;

/** Category each Foreman state must land in, and the fallback when the name is absent. */
const STATE_SPEC: Record<
  ForemanStateKey,
  { category: WorkflowStateType; fallback: ForemanStateKey | null }
> = {
  triage: { category: "triage", fallback: null },
  backlog: { category: "backlog", fallback: null },
  todo: { category: "unstarted", fallback: null },
  inProgress: { category: "started", fallback: null },
  inReview: { category: "started", fallback: "inProgress" },
  done: { category: "completed", fallback: null },
  canceled: { category: "canceled", fallback: null },
  duplicate: { category: "canceled", fallback: "canceled" },
};

export class StateResolutionError extends Error {
  constructor(key: ForemanStateKey, available: readonly WorkflowState[]) {
    super(
      `No Linear workflow state matches Foreman state "${FOREMAN_STATE[key]}" ` +
        `(category "${STATE_SPEC[key].category}"). Available: ` +
        available.map((s) => `${s.name} [${s.type}]`).join(", "),
    );
    this.name = "StateResolutionError";
  }
}

/**
 * Resolve a Foreman state to one of a team's real states.
 *
 * Order: exact name, then declared category, then the declared fallback. A
 * team with two `started` states resolves `In Review` by name, and one with a
 * single `In Progress` resolves it through the fallback rather than throwing.
 */
export function resolveState(
  key: ForemanStateKey,
  states: readonly WorkflowState[],
): WorkflowState {
  const spec = STATE_SPEC[key];
  const wanted = FOREMAN_STATE[key];

  const byName = states.find(
    (state) => state.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (byName) return byName;

  const byCategory = states
    .filter((state) => state.type === spec.category)
    .sort((a, b) => a.position - b.position)[0];
  if (byCategory) return byCategory;

  if (spec.fallback) return resolveState(spec.fallback, states);
  throw new StateResolutionError(key, states);
}

/** True when a state means the work is finished, either shipped or abandoned. */
export function isTerminal(state: { type: WorkflowStateType }): boolean {
  return state.type === "completed" || state.type === "canceled";
}

/** True when a blocker no longer blocks: it completed or was abandoned. */
export function blockerIsResolved(state: { type: WorkflowStateType }): boolean {
  return isTerminal(state);
}
