/**
 * SPEC §13.1 — the issue description template. This is the one place that
 * produces the exact section headings `acceptanceCriteria()` (linear/issue.ts)
 * parses back out, so the two must stay in lockstep: this renders, that reads.
 */

import { contextBody, sanitizeAgentText } from "@foreman/core";

export interface IssueDescriptionInput {
  context: string;
  acceptanceCriteria: string[];
  affectedAreas: string[];
  outOfScope: string[];
  /** Non-empty here means the issue isn't refined yet (SPEC §13.1). */
  openQuestions?: string[];
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_none_";
}

function renderCriteria(items: string[]): string {
  return items.length > 0
    ? items.map((item) => `- [ ] ${item}`).join("\n")
    : "_none_";
}

/**
 * SPEC §13.1. Deliberately omits the Definition of Done — that lives in the
 * product `Context` doc on the initiative, never restated per-issue (SPEC
 * §13.1 closing line).
 *
 * `context` is the `## Context` body, never the whole template: this function
 * owns every heading, and `acceptanceCriteria`/`affectedAreas`/`outOfScope`
 * are separate fields on each agent's result. A model that returns the full
 * template anyway is unwrapped rather than nested, so the stored description
 * always has exactly one of each section and `acceptanceCriteria()` reads
 * back the criteria the agent actually reported.
 */
export function renderIssueDescription(input: IssueDescriptionInput): string {
  const openQuestions = input.openQuestions ?? [];
  const context = (contextBody(input.context) ?? input.context).trim();
  return sanitizeAgentText(
    [
      "## Context",
      context.length > 0 ? context : "_none_",
      "",
      "## Acceptance Criteria",
      renderCriteria(input.acceptanceCriteria),
      "",
      "## Affected Areas",
      renderList(input.affectedAreas),
      "",
      "## Out of Scope",
      renderList(input.outOfScope),
      "",
      "## Open Questions",
      renderList(openQuestions),
    ].join("\n"),
  );
}
