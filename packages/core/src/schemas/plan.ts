import { type Static, Type } from "../typebox.ts";
import { TYPE_LABELS } from "../domain/labels.ts";
import { envelope } from "./envelope.ts";

const TypeLabelSchema = Type.Union(
  TYPE_LABELS.map((name) => Type.Literal(name)),
  { description: "The `type:` label this issue should carry." },
);

/** Fibonacci, read as agent-session size (SPEC §4.6) — a rough call, not a commitment. `foreman-refine` re-estimates against code. */
const RoughEstimateSchema = Type.Union(
  [
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(3),
    Type.Literal(5),
    Type.Literal(8),
  ],
  { description: "A rough call, not a commitment — `foreman-refine` re-estimates each issue against the code." },
);

export const ProposedIssue = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      description:
        "A short identifier for this proposal, unique within this result and referenced by " +
        "other entries' `blockedBy` (e.g. `schema`, `api`, `ui`). Local to the result only — " +
        "never written to Linear, which assigns the real identifiers on creation.",
    }),
    blockedBy: Type.Array(Type.String(), {
      description:
        "`key`s of other entries in this same result that must ship before this one. The " +
        "extension turns each into a native Linear `blocks` relation, which is what stops the " +
        "loop from implementing this issue before its prerequisites are done (SPEC §10). " +
        "Empty for anything that can start immediately. Must not form a cycle.",
    }),
    title: Type.String({ minLength: 1 }),
    type: TypeLabelSchema,
    description: Type.String({
      minLength: 1,
      description:
        "The `## Context` body only — why this issue exists, in prose. The extension renders the " +
        "SPEC §13.1 template around it from this plus `acceptanceCriteria` and `outOfScope`, so " +
        "emitting the headings yourself nests one template inside another. This is a starting " +
        "point, not a finished refinement — `foreman-refine` verifies and revises it against the " +
        "code, exactly as it already does for intake-drafted issues (SPEC §3.12).",
    }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
      description: "Draft observable behaviors. `foreman-refine` may revise these once it reads the code.",
    }),
    proposedPriority: Type.Union(
      [Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)],
      { description: "0 None, 1 Urgent, 2 High, 3 Medium, 4 Low (SPEC §4.3). Prefer a real priority — `None` leaves the issue outside the refine funnel until the operator sets one." },
    ),
    proposedEstimate: Type.Union([RoughEstimateSchema, Type.Null()], {
      description: "Rough size, or null when genuinely unknown. `foreman-refine` re-estimates against the code.",
    }),
    app: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "App this issue belongs to, matching one of the repo's configured apps (the FOREMAN-APPS " +
        "marker lists them). Null when the repo has no apps or the issue spans all of them.",
    }),
  },
  { additionalProperties: false, title: "ProposedIssue" },
);

export type ProposedIssue = Static<typeof ProposedIssue>;

export const PlanResult = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    proposedIssues: Type.Array(ProposedIssue, {
      description:
        "New Backlog issues that decompose the project brief into agent-sized units. " +
        "The extension creates each one directly, unlabeled and unprioritized — they enter " +
        "the normal refine funnel once the operator sets a priority.",
    }),
    outOfScope: Type.Array(Type.String(), {
      description: "Explicit non-goals for this pass, so a later planning pass does not re-propose them.",
    }),
    fullyPlanned: Type.Boolean({
      description:
        "True when proposedIssues, together with anything already in the project, cover the brief " +
        "end to end. Informational only: Foreman has no durable per-project flag, so this does not " +
        "change dispatch behavior on its own (SPEC known gap) — the real stop condition is that a " +
        "project with at least one issue never triggers `foreman-plan` again.",
    }),
    rationale: Type.String({
      minLength: 1,
      description: "How proposedIssues maps to the brief. Logged for the operator, not written to Linear.",
    }),
  },
  { additionalProperties: false, title: "PlanResult" },
);

export type PlanResult = Static<typeof PlanResult>;

export const PlanOutput = envelope(PlanResult, "foreman/plan-output");
export type PlanOutput = Static<typeof PlanOutput>;
