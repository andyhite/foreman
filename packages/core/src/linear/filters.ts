/**
 * Composable `IssueFilter` builders. Each returns a plain object passed
 * straight through to GraphQL (SPEC §4.10 saved views; `LinearApiScout`
 * verified `IssueFilter` field shapes).
 */

import type { IssueFilter } from "./api.ts";
import { AGENT_LABEL, groupDisplayName, labelDisplayName, LABEL_GROUP } from "../domain/labels.ts";
import { PRIORITY } from "../domain/priority.ts";

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

export function hasBlockedByRelations(present: boolean): IssueFilter {
  return { hasBlockedByRelations: { eq: present } };
}

export function all(...filters: IssueFilter[]): IssueFilter {
  return { and: filters };
}

export function any(...filters: IssueFilter[]): IssueFilter {
  return { or: filters };
}

/** SPEC §4.10.1: state = Triage. */
export const INBOX_FILTER: IssueFilter = inStateType("triage");

/** SPEC §4.10.2: any `blocked:*` label — the human interrupt queue. */
export const BLOCKED_HUMAN_FILTER: IssueFilter = hasAnyLabelPrefixed(LABEL_GROUP.blocked);

/**
 * SPEC §4.10.3: incomplete `blocked by` relation.
 *
 * `IssueFilter` can only express "has *any* blocked-by relation" — Linear has
 * no comparator for relation *state*, so this narrows the server-side result
 * to issues with at least one blocker and leaves the incompleteness check to
 * `incompleteBlockers` in `issue.ts` (SPEC §16 assumption 5). Callers must
 * post-filter the fetched issues with `incompleteBlockers(issue).length > 0`.
 */
export const BLOCKED_DEPS_FILTER: IssueFilter = hasBlockedByRelations(true);

/** SPEC §4.10.4: `agent:proposed`. */
export const PROPOSALS_FILTER: IssueFilter = hasLabelNamed(AGENT_LABEL.proposed);

/** SPEC §4.10.5: Todo AND `agent:ready` AND estimate set AND priority ≠ None. */
export function readyFilter(): IssueFilter {
  return all(
    inState("Todo"),
    hasLabelNamed(AGENT_LABEL.ready),
    estimateSet(),
    prioritized(),
  );
}

/** SPEC §4.10.6: `agent:running`. */
export const IN_FLIGHT_FILTER: IssueFilter = hasLabelNamed(AGENT_LABEL.running);
