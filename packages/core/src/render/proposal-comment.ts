import { AGENT_LABEL } from "../domain/labels.ts";
import { priorityName } from "../domain/priority.ts";
import type { TriageItem } from "../schemas/triage.ts";

/**
 * SPEC §7.1 — the human rendering of one `TriageItem`. The extension pairs
 * this with an embedded machine-readable copy in the same comment; approval
 * is entirely derivable from Linear, so this text must end with the exact
 * operator actions that drive `/foreman-apply`.
 */
export function renderProposalComment(item: TriageItem): string {
  const dedupeLine =
    item.duplicateOf !== null
      ? `Duplicate of ${item.duplicateOf}.`
      : "No duplicate found.";
  const blockersLine =
    item.proposedBlockedBy.length > 0
      ? item.proposedBlockedBy.join(", ")
      : "_none_";
  const missingInfoLine =
    item.missingInfo.length > 0
      ? item.missingInfo.map((line) => `- ${line}`).join("\n")
      : "_none_";

  return [
    `**Classification:** \`type:${item.type}\``,
    `**Proposed priority:** ${priorityName(item.proposedPriority)} — ${item.severityReasoning}`,
    `**Dedupe:** ${dedupeLine}`,
    `**Proposed blocked by:** ${blockersLine}`,
    `**Destination:** ${item.destination}`,
    `**Repro confidence:** ${item.reproConfidence}`,
    item.triageLabel !== null ? `**Triage disposition:** \`${item.triageLabel}\`` : null,
    "",
    "**Missing info:**",
    missingInfoLine,
    "",
    `To approve, remove the \`${AGENT_LABEL.proposed}\` label. To reject, reply ` +
      "`reject: <reason>`.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
