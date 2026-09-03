/**
 * Composable `IssueFilter` builders. Each returns a plain object passed
 * straight through to GraphQL (SPEC §4.10 saved views; `LinearApiScout`
 * verified `IssueFilter` field shapes).
 */

import type { IssueFilter } from "./api.ts";
import { groupDisplayName, labelDisplayName } from "../domain/labels.ts";
import { PRIORITY } from "../domain/priority.ts";
import { FOREMAN_STATE, TERMINAL_PROJECT_STATUS_TYPES, TERMINAL_STATE_TYPES } from "../domain/states.ts";

export function inState(name: string): IssueFilter {
  return { state: { name: { eq: name } } };
}

export function inStateType(type: string): IssueFilter {
  return { state: { type: { eq: type } } };
}

/**
 * Linear's actual label `name` is the nested child's own display name (e.g.
 * "Ready"), never our canonical colon-form id — so a grouped id filters on
 * both the child name and its parent group's name (SPEC §4.5).
 */
function labelMatch(id: string): Record<string, unknown> {
  const colon = id.indexOf(":");
  if (colon === -1) return { name: { eq: labelDisplayName(id) } };
  return {
    name: { eq: labelDisplayName(id.slice(colon + 1)) },
    parent: { name: { eq: groupDisplayName(id.slice(0, colon)) } },
  };
}

export function hasLabelNamed(id: string): IssueFilter {
  return { labels: { some: labelMatch(id) } };
}

export function lacksLabelNamed(id: string): IssueFilter {
  return { labels: { none: labelMatch(id) } };
}



export function prioritized(): IssueFilter {
  return { priority: { neq: PRIORITY.None } };
}

export function unprioritized(): IssueFilter {
  return { priority: { eq: PRIORITY.None } };
}

export function estimateSet(): IssueFilter {
  return { estimate: { neq: null } };
}

/** Accepts an ISO datetime or a Linear duration string (e.g. `"-P7D"`). */
export function updatedBefore(isoOrDuration: string): IssueFilter {
  return { updatedAt: { lt: isoOrDuration } };
}

export function inProject(id: string): IssueFilter {
  return { project: { id: { eq: id } } };
}


export function hasBlockedByRelations(present: boolean): IssueFilter {
  return { hasBlockedByRelations: { eq: present } };
}

/**
 * Excludes issues that have already finished — completed or canceled (SPEC
 * §4.2a). Server-side, because every consumer wants it and a `nin` on
 * `state.type` costs nothing while fetching fewer rows.
 */
export function notTerminalState(): IssueFilter {
  return { state: { type: { nin: [...TERMINAL_STATE_TYPES] } } };
}

/**
 * Excludes issues whose *project* has shipped or been abandoned (SPEC
 * §4.2a). The loop must not act on work inside a project the operator has
 * closed out, no matter what state the individual issue is still in.
 *
 * A project-less issue survives this filter: a project is optional on an
 * issue now, so `project: { null: true }` is a normal, supported case, not
 * a misfiled one. Verified against the live API: `IssueFilter.project` is a
 * `NullableProjectFilter`, so `null: true` is a real branch and
 * `status.type` is a real `StringComparator`.
 */
export function notInTerminalProject(): IssueFilter {
  return {
    or: [
      { project: { null: true } },
      { project: { status: { type: { nin: [...TERMINAL_PROJECT_STATUS_TYPES] } } } },
    ],
  };
}

/**
 * Excludes issues whose project is on the operator's hold (SPEC §4.2b).
 *
 * Narrower than `notInTerminalProject` on purpose, and composed by exactly
 * one worker: refinement. Refinement is the transition that *commits* work
 * — its output is an issue in Ready, estimated and hands-on, which implement
 * then picks up unattended. A pause withholds exactly that commitment, and
 * nothing more: it recalls nothing already in Ready or further right, so no
 * other query guards on it.
 *
 * Same project-less branch, same reason as above.
 */
export function notInPausedProject(): IssueFilter {
  return {
    or: [
      { project: { null: true } },
      { project: { status: { type: { neq: "paused" } } } },
    ],
  };
}

export function all(...filters: IssueFilter[]): IssueFilter {
  return { and: filters };
}

export function any(...filters: IssueFilter[]): IssueFilter {
  return { or: filters };
}

/** SPEC §4.10.1: state = Triage. */
export const INBOX_FILTER: IssueFilter = inStateType("triage");

/** `Needs Input` — the refine-stage human interrupt queue: foreman-refine couldn't proceed. */
export const NEEDS_INPUT_FILTER: IssueFilter = all(
  inState(FOREMAN_STATE.needsInput),
  notInTerminalProject(),
);

/** `Blocked` — the implementation-stage human interrupt queue: foreman-implement, foreman-review, or a build-loop escalation couldn't proceed. */
export const BLOCKED_FILTER: IssueFilter = all(
  inState(FOREMAN_STATE.blocked),
  notInTerminalProject(),
);

/** Every issue waiting on the operator, regardless of which stage stalled — the loop's overall backpressure signal. */
export const HUMAN_QUEUE_FILTER: IssueFilter = any(NEEDS_INPUT_FILTER, BLOCKED_FILTER);

/** `Refining` or `In Progress` — an agent is actively working the issue. */
export const RUNNING_FILTER: IssueFilter = any(
  inState(FOREMAN_STATE.refining),
  inState(FOREMAN_STATE.inProgress),
);

/** Issue unassigned, or assigned to this credential itself — excludes issues a human operator claimed for themselves. */
export function notHandsOff(viewerId: string): IssueFilter {
  return { or: [{ assignee: { null: true } }, { assignee: { id: { eq: viewerId } } }] };
}
