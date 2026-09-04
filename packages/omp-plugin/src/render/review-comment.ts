import type { Finding, ReviewResult } from "@foreman/core";
import { renderContextContradictionsSection } from "./context-contradictions.ts";

const SEVERITY_ORDER = ["blocking", "should-fix", "nit"] as const;

function renderFindingLine(finding: Finding): string {
  const location = finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
  return `- ${location} — ${finding.description}\n  _${finding.severity}: ${finding.severityRationale}_`;
}

/**
 * SPEC §13.4 — findings grouped by severity, worst first. A severity with no
 * findings is stated explicitly rather than omitted, so an empty `blocking`
 * group reads as "checked, clean" rather than "forgot to check."
 */
function renderFindingsBySeverity(findings: readonly Finding[]): string {
  return SEVERITY_ORDER.map((severity) => {
    const inGroup = findings.filter((finding) => finding.severity === severity);
    const body =
      inGroup.length > 0
        ? inGroup.map(renderFindingLine).join("\n")
        : "_none_";
    return `### ${severity}\n${body}`;
  }).join("\n\n");
}

export function renderReviewComment(result: ReviewResult): string {
  const criteriaLines = result.criteriaVerification
    .map(
      (entry) =>
        `- [${entry.satisfied ? "x" : " "}] ${entry.criterion} — ${entry.evidence}`,
    )
    .join("\n");
  const dodLines = result.dodChecklist
    .map((check) => `- [${check.satisfied ? "x" : " "}] ${check.item} — ${check.evidence}`)
    .join("\n");
  const scopeCreepBody = result.scopeCreep.length > 0
    ? result.scopeCreep.map((item) => `- ${item}`).join("\n")
    : "_none_";
  const contradictionsSection = renderContextContradictionsSection(result.contextContradictions);

  return [
    `Reviewed \`${result.reviewedSha}\`. Verdict: **${result.verdict}**.`,
    "",
    "## Acceptance Criteria",
    criteriaLines.length > 0 ? criteriaLines : "_none_",
    "",
    "## Definition of Done",
    dodLines.length > 0 ? dodLines : "_none_",
    "",
    "## Findings",
    renderFindingsBySeverity(result.findings),
    "",
    "## Project Organization",
    result.projectOrganization,
    "",
    "## Scope Creep",
    scopeCreepBody,
    "",
    "## Test Adequacy",
    result.testAdequacy,
    ...(contradictionsSection !== null ? ["", contradictionsSection] : []),
  ].join("\n");
}
