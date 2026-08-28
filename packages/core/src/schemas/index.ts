export * from "./envelope.ts";
export * from "./triage.ts";
export * from "./refine.ts";
export * from "./implement.ts";
export * from "./review.ts";

import { ImplementOutput } from "./implement.ts";
import { RefineOutput } from "./refine.ts";
import { ReviewOutput } from "./review.ts";
import { TriageOutput } from "./triage.ts";

/**
 * The complete set of agent output envelopes (SPEC §6), keyed by the agent
 * name that produces them. `parse.ts` and `emit-schemas.ts` both drive off
 * this registry so there is exactly one place that knows all four agents.
 */
export const AGENT_OUTPUT_SCHEMAS = {
  "foreman-triage": TriageOutput,
  "foreman-refine": RefineOutput,
  "foreman-implement": ImplementOutput,
  "foreman-review": ReviewOutput,
} as const;

export type ForemanAgentName = keyof typeof AGENT_OUTPUT_SCHEMAS;

/**
 * Filenames each agent's schema is emitted to under `packages/omp-plugin/schemas/`
 * (SPEC §7 frontmatter `output:` paths).
 */
export const SCHEMA_FILENAMES: Record<ForemanAgentName, string> = {
  "foreman-triage": "triage-proposal.json",
  "foreman-refine": "refine-result.json",
  "foreman-implement": "implement-result.json",
  "foreman-review": "review-result.json",
};
