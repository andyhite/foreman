import { type Static, Type } from "../typebox.ts";
import { envelope } from "./envelope.ts";

const ContextDocSection = Type.Union(
  [Type.Literal("decisions"), Type.Literal("vocabulary"), Type.Literal("non-goals")],
  { description: "Which of the three agent-proposable Context doc sections this refers to." },
);

export const ContextRemoval = Type.Object(
  {
    section: ContextDocSection,
    text: Type.String({
      minLength: 1,
      description:
        "The exact line dropped from the current section body. Must match a line present in " +
        "the live doc — this is what lets the merge tell an intentional removal from silent loss.",
    }),
    reason: Type.String({
      minLength: 1,
      description: "Why this line no longer belongs — superseded, contradicted by shipped code, duplicate, etc.",
    }),
  },
  { additionalProperties: false, title: "ContextRemoval" },
);

export type ContextRemoval = Static<typeof ContextRemoval>;

/**
 * `ContextResult` has no Definition-of-Done field, under any spelling. The
 * DoD section of the product Context doc is the bar `foreman-review` grades
 * `dodSatisfied` against (SPEC §4.7, §4.8); an agent able to rewrite that
 * section could move its own review bar. Rather than police that with a
 * runtime check, the field is absent from the schema, so no agent output can
 * express a change to it — the merge step (`mergeContextDoc`) always carries
 * the live doc's Definition of Done through verbatim.
 */
export const ContextResult = Type.Object(
  {
    teamId: Type.String({
      minLength: 1,
      description: "The Linear team whose Context doc this proposal updates — the repo's team.",
    }),
    decisions: Type.String({
      description:
        "The FULL new body of the 'Architectural decisions and constraints' section, not a " +
        "delta against the current one. Any non-empty line present in the current section that " +
        "is missing here must appear in `removals` with `section: \"decisions\"`, or the whole " +
        "result is refused — this is how a recorded decision cannot be silently dropped.",
    }),
    vocabulary: Type.String({
      description:
        "The FULL new body of the 'Domain vocabulary' section, not a delta against the current " +
        "one. Any non-empty line present in the current section that is missing here must appear " +
        "in `removals` with `section: \"vocabulary\"`, or the whole result is refused.",
    }),
    nonGoals: Type.String({
      description:
        "The FULL new body of the 'Known non-goals' section, not a delta against the current " +
        "one. Any non-empty line present in the current section that is missing here must appear " +
        "in `removals` with `section: \"non-goals\"`, or the whole result is refused.",
    }),
    removals: Type.Array(ContextRemoval, {
      description:
        "Every non-empty line dropped from `decisions`, `vocabulary`, or `nonGoals` relative to " +
        "the doc you were given, each with the reason it no longer belongs. Empty when nothing " +
        "was removed.",
    }),
    changeSummary: Type.String({
      minLength: 1,
      description: "Operator-facing summary of what this proposal changes and why, shown before it is applied.",
    }),
    rationale: Type.String({
      minLength: 1,
      description: "Why this update is warranted. Logged for the operator, never written to Linear.",
    }),
  },
  { additionalProperties: false, title: "ContextResult" },
);

export type ContextResult = Static<typeof ContextResult>;

export const ContextOutput = envelope(ContextResult, "foreman/context-output");
export type ContextOutput = Static<typeof ContextOutput>;
