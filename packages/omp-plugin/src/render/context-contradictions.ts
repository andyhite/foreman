import type { ContextContradiction } from "@foreman/core";

function renderContextContradictionLine(contradiction: ContextContradiction): string {
  return `- **${contradiction.section}**: recorded as "${contradiction.recorded}" — contradicted at ${contradiction.evidence}`;
}

/**
 * SPEC §4.7 — the product `Context` doc has exactly one pruning signal: an
 * agent finding code that contradicts a recorded decision. There is no
 * sweep and no age timer, so a non-empty array here is the operator's only
 * cue that a doc entry is stale or the code is wrong, and resolving it is
 * part of the issue the comment is attached to. `null` (not `""`) on an
 * empty array so callers can omit the heading entirely rather than print a
 * "checked, clean" section that would be noise on every comment.
 */
export function renderContextContradictionsSection(contradictions: readonly ContextContradiction[]): string | null {
  if (contradictions.length === 0) return null;
  return [
    "## Context Doc Contradictions",
    "The Context doc entries below no longer match the code — either the doc is stale or the code is wrong. Resolve this as part of the current issue.",
    contradictions.map(renderContextContradictionLine).join("\n"),
  ].join("\n");
}
