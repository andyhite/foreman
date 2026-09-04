import type { ImplementResult } from "@foreman/core";
import { renderContextContradictionsSection } from "./context-contradictions.ts";

/** SPEC §7.3 — the human-readable half of the implement marker comment: branch, PR (or its absence in direct-branch mode), approach, and any Context doc contradictions the agent surfaced while implementing. */
export function renderImplementComment(result: ImplementResult): string {
  const contradictionsSection = renderContextContradictionsSection(result.contextContradictions);

  return [
    `**Branch:** ${result.branch}`,
    result.prUrl.length > 0 ? `**PR:** ${result.prUrl}` : "**PR:** none (direct-branch mode)",
    `**Approach:** ${result.approachSummary}`,
    ...(contradictionsSection !== null ? ["", contradictionsSection] : []),
  ].join("\n");
}
