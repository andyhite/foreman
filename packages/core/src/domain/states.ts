/**
 * Workflow states (SPEC §4.2 rework). Eight states are provisioned per team
 * by `foreman init` (see `provision.ts`), resolved by exact name — no
 * category inference, no fallback chain. `Triage` and `Duplicate` are both
 * Linear's own system-managed states: `Triage` is created when the team's
 * triage setting is turned on, and `Duplicate` always exists natively
 * (`workflowStateCreate` accepts neither `type: "triage"` nor
 * `type: "duplicate"`). Both are resolved by category instead of name, since
 * the operator may rename either.
 */

import type { ProjectStatusType, WorkflowState, WorkflowStateType } from "../linear/types.ts";

export const FOREMAN_STATE = {
  triage: "Triage",
  backlog: "Backlog",
  refining: "Refining",
  needsInput: "Needs Input",
  ready: "Ready",
  inProgress: "In Progress",
  blocked: "Blocked",
  inReview: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as const;

export type ForemanStateKey = keyof typeof FOREMAN_STATE;

/** States Linear manages itself and never accepts on `workflowStateCreate`. */
type SystemManagedStateKey = "triage" | "duplicate";

/**
 * Ascending board order. Linear renders columns grouped by `type`'s fixed
 * category order (backlog, unstarted, started, completed, canceled) first,
 * `position` second — a `started` state before an `unstarted` one still
 * renders *after* it, and *within* a category the icon variant itself also
 * follows `position` (each successive `started` state gets a more "advanced"
 * icon). `Refining` and `Needs Input` are `unstarted`, not `started`: both
 * happen before implementation work starts. `Blocked` stays `started` (it
 * only exists once `In Progress` began) but sorts first among the started
 * states, ahead of `In Progress`/`In Review`, so its icon doesn't wrongly
 * read as further along than the work it interrupted. `position` is passed
 * straight to `workflowStateCreate`.
 */
export interface ManagedStateSpec {
  key: Exclude<ForemanStateKey, SystemManagedStateKey>;
  name: string;
  /** `WorkflowStateCreateInput.type`. */
  type: Exclude<WorkflowStateType, "triage" | "duplicate">;
  color: string;
  description: string;
  position: number;
}
export const MANAGED_STATES: readonly ManagedStateSpec[] = [
  {
    key: "backlog",
    name: FOREMAN_STATE.backlog,
    type: "backlog",
    color: "#bec2c8",
    description: "Prioritized, not yet refined.",
    position: 0,
  },
  {
    key: "refining",
    name: FOREMAN_STATE.refining,
    type: "unstarted",
    color: "#f2c94c",
    description: "foreman-refine is working on this.",
    position: 1,
  },
  {
    key: "needsInput",
    name: FOREMAN_STATE.needsInput,
    type: "unstarted",
    color: "#eb5757",
    description: "foreman-refine needs the operator; answer with /foreman:unblock.",
    position: 2,
  },
  {
    key: "ready",
    name: FOREMAN_STATE.ready,
    type: "unstarted",
    color: "#e2e2e2",
    description: "Refined and implementable.",
    position: 3,
  },
  {
    key: "blocked",
    name: FOREMAN_STATE.blocked,
    type: "started",
    color: "#eb5757",
    description: "foreman-implement or foreman-review needs the operator; answer with /foreman:unblock.",
    position: 4,
  },
  {
    key: "inProgress",
    name: FOREMAN_STATE.inProgress,
    type: "started",
    color: "#f2994a",
    description: "foreman-implement is working on this.",
    position: 5,
  },
  {
    key: "inReview",
    name: FOREMAN_STATE.inReview,
    type: "started",
    color: "#26b5ce",
    description: "PR open, awaiting review or merge.",
    position: 6,
  },
  {
    key: "done",
    name: FOREMAN_STATE.done,
    type: "completed",
    color: "#5e6ad2",
    description: "Shipped.",
    position: 7,
  },
  {
    key: "canceled",
    name: FOREMAN_STATE.canceled,
    type: "canceled",
    color: "#95a2b3",
    description: "Abandoned.",
    position: 8,
  },
];

export class StateResolutionError extends Error {
  constructor(key: ForemanStateKey, available: readonly WorkflowState[]) {
    super(
      `No Linear workflow state named "${FOREMAN_STATE[key]}" on this team. ` +
        `Available: ${available.map((s) => `${s.name} [${s.type}]`).join(", ")} — ` +
        `run \`foreman doctor --fix\` to provision Foreman's states.`,
    );
    this.name = "StateResolutionError";
  }
}

/**
 * Resolve a Foreman state to one of a team's real states.
 *
 * `triage` and `duplicate` are the two exceptions: Linear manages both
 * states itself (the operator may rename either), so both resolve by
 * category instead of name.
 */
export function resolveState(
  key: ForemanStateKey,
  states: readonly WorkflowState[],
): WorkflowState {
  if (key === "triage" || key === "duplicate") {
    const byType = states.find((state) => state.type === key);
    if (byType) return byType;
    throw new StateResolutionError(key, states);
  }

  const wanted = FOREMAN_STATE[key];
  const byName = states.find((state) => state.name.trim().toLowerCase() === wanted.toLowerCase());
  if (byName) return byName;

  throw new StateResolutionError(key, states);
}

/**
 * The two workflow-state categories that mean no further work will happen
 * here. Declared once and read by every terminal check, so "what counts as
 * finished" has exactly one definition (SPEC §4.2a).
 */
export const TERMINAL_STATE_TYPES: readonly WorkflowStateType[] = ["completed", "canceled", "duplicate"];

/** True when a state means the work is finished, either shipped or abandoned. */
export function isTerminal(state: { type: WorkflowStateType }): boolean {
  return TERMINAL_STATE_TYPES.includes(state.type);
}

/** True when a blocker no longer blocks: it completed or was abandoned. */
export function blockerIsResolved(state: { type: WorkflowStateType }): boolean {
  return isTerminal(state);
}

/**
 * `TERMINAL_STATE_TYPES`' project-level sibling. A separate list because
 * `ProjectStatusType` is a separate enum, not because the two disagree.
 *
 * `paused` is deliberately absent: a paused project is on hold, not
 * finished. Un-pausing it must resume the loop with no other edit, and
 * treating it as terminal here would make that resume silent and
 * indistinguishable from abandonment (SPEC §7.6a). Pausing does hold one
 * specific transition — see `isPausedProjectStatus`.
 */
export const TERMINAL_PROJECT_STATUS_TYPES: readonly ProjectStatusType[] = ["completed", "canceled"];

/**
 * True when a project has shipped or been abandoned. A project with no
 * status at all is *not* terminal — an unset status means the operator never
 * picked one, which is the opposite of a decision to stop.
 */
export function isTerminalProjectStatus(status: { type: ProjectStatusType } | null | undefined): boolean {
  return status != null && TERMINAL_PROJECT_STATUS_TYPES.includes(status.type);
}

/**
 * True when a project is on the operator's reversible hold.
 *
 * Narrower than terminal by design, and read by exactly one transition:
 * refinement, whose whole output is a *new* issue in Todo (SPEC §4.2b).
 * Pausing a project says "commit nothing further here for now", so
 * promoting more of its Backlog into the implementable queue is the one
 * thing that must stop. Work already in Todo or further right is already
 * committed and keeps moving — a pause is not a recall.
 */
export function isPausedProjectStatus(status: { type: ProjectStatusType } | null | undefined): boolean {
  return status?.type === "paused";
}
