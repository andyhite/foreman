import { type Static, Type } from "../typebox.ts";
import { TYPE_LABELS } from "../domain/labels.ts";
import { envelope } from "./envelope.ts";

const TypeLabelSchema = Type.Union(
  TYPE_LABELS.map((name) => Type.Literal(name)),
  { description: "The `type:` label this sub-issue should carry." },
);

/** Fibonacci, read as agent-session size (SPEC §4.6). 5 means split; 8 means not an issue. */
const EstimateSchema = Type.Union(
  [
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(3),
    Type.Literal(5),
    Type.Literal(8),
  ],
  {
    description:
      "1 single file; 2 a few files; 3 multiple files and one non-obvious decision; " +
      "5 must be split into subIssues; 8 is not an issue — propose a spike or a project.",
  },
);

export const SubIssue = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    type: TypeLabelSchema,
    description: Type.String({
      minLength: 1,
      description:
        "The `## Context` body only, same as `refinedDescription` — the extension renders the " +
        "SPEC §13.1 template around it.",
    }),
    estimate: EstimateSchema,
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false, title: "SubIssue" },
);

export type SubIssue = Static<typeof SubIssue>;

export const SpikeSpec = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    question: Type.String({
      minLength: 1,
      description: "The single unknown the spike answers.",
    }),
    budget: Type.String({
      minLength: 1,
      description: "Stated ceiling, e.g. 'one session' or '2 points'.",
    }),
    deliverable: Type.String({
      minLength: 1,
      description:
        "The artifact that ends the spike. A spike with no written deliverable " +
        "is unbilled wandering (SPEC §13.3).",
    }),
  },
  { additionalProperties: false, title: "SpikeSpec" },
);

export type SpikeSpec = Static<typeof SpikeSpec>;

export const RefineResult = Type.Object(
  {
    issueId: Type.String({ minLength: 1 }),
    refinedDescription: Type.String({
      minLength: 1,
      description:
        "The `## Context` body only — why this issue exists, in prose. The extension renders the " +
        "SPEC §13.1 template around it from this plus `acceptanceCriteria`, `affectedAreas`, and " +
        "`outOfScope`; emitting the headings yourself nests one template inside another. Do not " +
        "restate the Definition of Done. A refined issue leaves no open questions behind.",
    }),
    estimate: EstimateSchema,
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Observable behaviors, verifiable by someone who did not write the code. " +
        "Empty only when this issue became a tracking parent.",
    }),
    affectedAreas: Type.Array(Type.String(), {
      description: "Files and modules identified via LSP, not guessed.",
    }),
    outOfScope: Type.Array(Type.String(), {
      description: "Explicit non-goals. This is what prevents implement-time scope creep.",
    }),
    subIssues: Type.Array(SubIssue, {
      description:
        "Non-empty when `estimate` is 5 or more: the parent becomes a tracking " +
        "issue that stays out of the implement rule's candidates.",
    }),
    spikeCreated: Type.Union([SpikeSpec, Type.Null()], {
      description:
        "A spike to create with a native `blocks` relation to this issue, when a " +
        "genuine unknown blocks estimation. Do not guess instead.",
    }),
    readyForImplementation: Type.Boolean({
      description:
        "True only when this exact issue can be picked up as-is. False for a " +
        "tracking parent or an issue waiting on a spike.",
    }),
  },
  { additionalProperties: false, title: "RefineResult" },
);

export type RefineResult = Static<typeof RefineResult>;

export const RefineOutput = envelope(RefineResult, "foreman/refine-output");
export type RefineOutput = Static<typeof RefineOutput>;
