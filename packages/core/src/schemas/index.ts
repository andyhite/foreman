export * from "./envelope.ts";
export * from "./dependencies.ts";
export * from "./triage.ts";
export * from "./refine.ts";
export * from "./implement.ts";
export * from "./review.ts";
export * from "./plan.ts";
export * from "./roadmap.ts";

import { ImplementOutput } from "./implement.ts";
import { PlanOutput } from "./plan.ts";
import { RefineOutput } from "./refine.ts";
import { ReviewOutput } from "./review.ts";
import { RoadmapOutput } from "./roadmap.ts";
import { TriageOutput } from "./triage.ts";

/**
 * The complete set of agent output envelopes (SPEC §6), keyed by the agent
 * name that produces them. `parse.ts` and `emit-schemas.ts` both drive off
 * this registry so there is exactly one place that knows all six agents.
 */
export const AGENT_OUTPUT_SCHEMAS = {
  "foreman-triage": TriageOutput,
  "foreman-plan": PlanOutput,
  "foreman-roadmap": RoadmapOutput,
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
  "foreman-triage": "triage-result.json",
  "foreman-plan": "plan-result.json",
  "foreman-roadmap": "roadmap-result.json",
  "foreman-refine": "refine-result.json",
  "foreman-implement": "implement-result.json",
  "foreman-review": "review-result.json",
};
