import type { SpikeSpec } from "@foreman/core";

/** SPEC §13.3 — a spike issue is `type:spike` with a question, a budget, and a Deliverable. */
export function renderSpikeIssue(spec: SpikeSpec, blocks: { identifier: string }): string {
  return [
    "## Question",
    spec.question,
    "",
    "## Budget",
    spec.budget,
    "",
    "## Deliverable",
    spec.deliverable,
    "",
    `A native \`blocks\` relation to ${blocks.identifier} is created by the extension — ` +
      "this spike blocks that issue's estimation until the deliverable lands.",
  ].join("\n");
}
