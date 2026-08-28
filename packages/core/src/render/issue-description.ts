/**
 * SPEC §13.1 — the issue description template. This is the one place that
 * produces the exact section headings `acceptanceCriteria()` (linear/issue.ts)
 * parses back out, so the two must stay in lockstep: this renders, that reads.
 */

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
 * project Context doc, never restated per-issue (SPEC §13.1 closing line).
 */
export function renderIssueDescription(input: IssueDescriptionInput): string {
  const openQuestions = input.openQuestions ?? [];
  return [
    "## Context",
    input.context.trim().length > 0 ? input.context.trim() : "_none_",
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
  ].join("\n");
}
