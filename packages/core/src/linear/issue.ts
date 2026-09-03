/**
 * Pure accessors over a fetched `Issue`. No network access lives here — every
 * function takes an already-hydrated `Issue` and reads it, so gates and
 * workers can call these without caring whether the issue came from a fresh
 * fetch or a cached one.
 */

import type { Issue, IssueRef, IssueRelation } from "./types.ts";
import { blockerIsResolved } from "../domain/states.ts";

/** Edges where `other` blocks this issue (SPEC §4: `blocks`, seen from the target). */
export function blockedByRelations(issue: Issue): IssueRelation[] {
  return issue.relations.filter(
    (relation) => relation.type === "blocks" && relation.direction === "incoming",
  );
}

/** Edges where this issue blocks `other`. */
export function blockingRelations(issue: Issue): IssueRelation[] {
  return issue.relations.filter(
    (relation) => relation.type === "blocks" && relation.direction === "outgoing",
  );
}

/**
 * True when a human operator, not this credential, is steering the issue —
 * they assigned it to themselves directly, so agents leave it alone. The
 * credential's own assignment (`claimLock`'s in-flight lock) is excluded by
 * comparing against `viewerId`, the one signal that distinguishes "an agent
 * is working this" from "the operator wants this to itself."
 */
export function isHandsOff(issue: { assignee: { id: string } | null }, viewerId: string): boolean {
  return issue.assignee !== null && issue.assignee.id !== viewerId;
}

/**
 * Blockers that still block: their state has not reached a terminal category.
 * This is the check `IssueFilter.hasBlockedByRelations` cannot express on its
 * own (SPEC §16 assumption 5) — the filter can only narrow to "has any
 * blocked-by relation at all", and this function finishes the job in code.
 */
export function incompleteBlockers(issue: Issue): IssueRelation[] {
  return blockedByRelations(issue).filter(
    (relation) => !blockerIsResolved(relation.other.state),
  );
}

/** The issue this one was marked a duplicate of, if any. */
export function duplicateOf(issue: Issue): IssueRef | null {
  const relation = issue.relations.find(
    (candidate) => candidate.type === "duplicate" && candidate.direction === "outgoing",
  );
  return relation ? relation.other : null;
}

const CONTEXT_HEADING = /^##\s+Context\s*$/m;
const ACCEPTANCE_CRITERIA_HEADING = /^##\s+Acceptance Criteria\s*$/m;
const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/m;
const NEXT_HEADING = /^##\s+/m;
const CHECKBOX_LINE = /^-\s*\[[ xX]\]\s*(.+)$/;

/**
 * Extract the body of one `##` section from a SPEC §13.1-template description,
 * stopping at the next `##` heading or end of string. Shared by acceptance
 * criteria and open questions since both are markdown sections under the same
 * template — kept as one function rather than two because the slicing logic
 * (find heading, find next heading, slice between) is the non-trivial part.
 */
function sectionBody(description: string, heading: RegExp): string | null {
  const match = heading.exec(description);
  if (!match) return null;
  const start = match.index + match[0].length;
  NEXT_HEADING.lastIndex = 0;
  const rest = description.slice(start);
  const next = NEXT_HEADING.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Text of every checkbox line (`- [ ]` or `- [x]`) under `## Acceptance Criteria`. */
export function acceptanceCriteria(description: string | null): string[] {
  if (!description) return [];
  const body = sectionBody(description, ACCEPTANCE_CRITERIA_HEADING);
  if (!body) return [];
  const criteria: string[] = [];
  for (const line of body.split("\n")) {
    const match = CHECKBOX_LINE.exec(line.trim());
    if (match?.[1]) criteria.push(match[1].trim());
  }
  return criteria;
}

/** SPEC §4.10 refinement gate: `## Acceptance Criteria` present with ≥1 checkbox line. */
export function hasAcceptanceCriteria(description: string | null): boolean {
  return acceptanceCriteria(description).length > 0;
}

/**
 * The `## Context` body of a SPEC §13.1 description, or null when the text
 * carries no such heading — in which case it already *is* a context body.
 *
 * Every agent contract asks for the context prose alone and leaves the
 * template to the renderer, but a model that hands back the whole template
 * anyway must not end up with one template nested inside another's Context
 * section, so `renderIssueDescription` unwraps through here first.
 */
export function contextBody(description: string | null): string | null {
  if (!description) return null;
  return sectionBody(description, CONTEXT_HEADING);
}

/**
 * Free-text lines under `## Open Questions`. The template placeholder text
 * ("<empty at Todo; anything here means it isn't refined>") is filtered out
 * so a freshly-drafted, unedited description reads as having no questions.
 */
export function openQuestions(description: string | null): string[] {
  if (!description) return [];
  const body = sectionBody(description, OPEN_QUESTIONS_HEADING);
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<") && line !== "_none_");
}
