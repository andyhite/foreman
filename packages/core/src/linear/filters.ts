/**
 * Composable `IssueFilter` builders. Each returns a plain object passed
 * straight through to GraphQL (SPEC §4.10 saved views; `LinearApiScout`
 * verified `IssueFilter` field shapes).
 */

import type { IssueFilter } from "./api.ts";
import { AGENT_LABEL, groupDisplayName, labelDisplayName, LABEL_GROUP } from "../domain/labels.ts";
import { PRIORITY } from "../domain/priority.ts";
import { TERMINAL_PROJECT_STATUS_TYPES, TERMINAL_STATE_TYPES } from "../domain/states.ts";

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

export function lacksLabelPrefixed(prefix: string): IssueFilter {
  return { labels: { none: { parent: { name: { eq: groupDisplayName(prefix) } } } } };
}

export function hasAnyLabelPrefixed(prefix: string): IssueFilter {
  return { labels: { some: { parent: { name: { eq: groupDisplayName(prefix) } } } } };
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

/**
 * Every issue under any of these initiatives, filtered through the project
 * edge in a single hop (verified live: `IssueFilter` has no direct
 * initiative field, but `NullableProjectFilter.initiatives` does — see
 * docs/VERIFIED.md). Lets a worker that needs "every issue across an
 * initiative's projects" ask once instead of once per project.
 */
export function inInitiatives(ids: readonly string[]): IssueFilter {
  return { project: { initiatives: { some: { id: { in: ids } } } } };
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
 * Project-less issues deliberately survive this filter. They are already
 * out of scope for a different, more specific reason (`issueScope`'s
 * `no-project`), and that verdict is what the operator sees in
 * `/foreman:status` — swallowing them here would hide a misfiled issue
 * behind the wrong explanation. Verified against the live API:
 * `IssueFilter.project` is a `NullableProjectFilter`, so `null: true` is a
 * real branch and `status.type` is a real `StringComparator`.
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
 * — its output is an issue in Todo, estimated and `agent:ready`, which
 * implement then picks up unattended. A pause withholds exactly that
 * commitment, and nothing more: it recalls nothing already in Todo or
 * further right, so no other query guards on it.
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

/**
 * SPEC §4.10.2: any `blocked:*` label — the human interrupt queue.
 *
 * Terminal issues and terminal projects are excluded, and that exclusion is
 * load-bearing rather than cosmetic: this view's *count* is the loop's
 * backpressure signal (SPEC §17.7). A `blocked:` label left behind on a
 * canceled issue would otherwise hold the whole loop stopped forever, with
 * nothing an operator could do about it except hunt down a label on work
 * nobody will ever return to.
 */
export const BLOCKED_HUMAN_FILTER: IssueFilter = all(
  hasAnyLabelPrefixed(LABEL_GROUP.blocked),
  notTerminalState(),
  notInTerminalProject(),
);

/**
 * SPEC §4.10.3: incomplete `blocked by` relation.
 *
 * `IssueFilter` can only express "has *any* blocked-by relation" — Linear has
 * no comparator for relation *state*, so this narrows the server-side result
 * to issues with at least one blocker and leaves the incompleteness check to
 * `incompleteBlockers` in `issue.ts` (SPEC §16 assumption 5). Callers must
 * post-filter the fetched issues with `incompleteBlockers(issue).length > 0`.
 */
export const BLOCKED_DEPS_FILTER: IssueFilter = all(
  hasBlockedByRelations(true),
  notTerminalState(),
  notInTerminalProject(),
);

/**
 * SPEC §4.10.4: `agent:proposed`.
 *
 * Terminal-excluded for the same reason as the blocked queue: the team
 * loop's backpressure reads this count (`packages/loop/src/team.ts`), and
 * `applyTriage` moves an issue to Canceled *and* strips the label — so a
 * canceled issue still carrying `agent:proposed` is a half-applied
 * proposal, not a queue item waiting on the operator.
 */
export const PROPOSALS_FILTER: IssueFilter = all(
  hasLabelNamed(AGENT_LABEL.proposed),
  notTerminalState(),
  notInTerminalProject(),
);

/**
 * SPEC §4.10.5: Todo AND `agent:ready` AND estimate set AND priority ≠ None.
 *
 * `notTerminalState()` is absent by construction — `Todo` already pins the
 * state. The project guard is not: a Todo issue inside a canceled project
 * would otherwise count toward `readyBufferTarget` and stop the refine
 * worker from stocking the buffer with work that can actually start.
 */
export function readyFilter(): IssueFilter {
  return all(
    inState("Todo"),
    hasLabelNamed(AGENT_LABEL.ready),
    estimateSet(),
    prioritized(),
    notInTerminalProject(),
  );
}

/**
 * SPEC §4.10.6: `agent:running`.
 *
 * Deliberately *not* terminal-filtered, and the one view where that is the
 * point: a lock still held on an issue that has since been completed or
 * canceled is exactly the stale lock the reaper (§11) exists to release.
 * Filtering it out would strand the lock and hide it from the operator.
 */
export const IN_FLIGHT_FILTER: IssueFilter = hasLabelNamed(AGENT_LABEL.running);
