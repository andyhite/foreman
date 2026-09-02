import type { DiscoveredWork, ImplementResult } from "@foreman/core";

export interface PrBodyInput {
  issue: { identifier: string; url: string; title: string };
  result: ImplementResult;
  definitionOfDone: string[];
}

function renderDiscoveredWork(items: readonly DiscoveredWork[]): string {
  if (items.length === 0) return "_none_";
  return items
    .map((item) => `- **${item.title}** (${item.type}, ${item.relation}) — ${item.description}`)
    .join("\n");
}

/**
 * SPEC §13.2 — the one artifact the extension never renders. The PR must
 * exist before the implement agent's yield (SPEC §7.3), so the agent authors
 * this body itself from the same `ImplementResult` at PR-creation time; the
 * extension reads the PR back but never rewrites this text.
 */
export function renderPrBody(input: PrBodyInput): string {
  const { issue, result, definitionOfDone } = input;
  const criteriaChecklist = result.criteriaMet
    .map((entry) => `- [x] ${entry.criterion} — ${entry.evidence}`)
    .join("\n");
  const dodChecklist =
    definitionOfDone.length > 0
      ? definitionOfDone.map((item) => `- [ ] ${item}`).join("\n")
      : "_none_";
  const testsNote =
    result.testsAdded.length > 0
      ? result.testsAdded.map((test) => `- \`${test.path}\` — covers: ${test.covers}`).join("\n")
      : "_none_";

  return [
    `Closes [${issue.identifier}](${issue.url}): ${issue.title}`,
    "",
    "## Approach",
    result.approachSummary,
    "",
    "## Acceptance Criteria",
    criteriaChecklist.length > 0 ? criteriaChecklist : "_none_",
    "",
    "## Test Coverage",
    testsNote,
    "",
    "## Definition of Done",
    dodChecklist,
    "",
    "## Discovered work",
    renderDiscoveredWork(result.discoveredWork),
  ].join("\n");
}
