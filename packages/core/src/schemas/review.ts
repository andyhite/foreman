import { type Static, Type } from "../typebox.ts";
import { envelope } from "./envelope.ts";

export const FindingSeverity = Type.Union(
  [
    Type.Literal("blocking"),
    Type.Literal("should-fix"),
    Type.Literal("nit"),
  ],
  {
    description:
      "`blocking` routes back to implement and burns one of the two review→fix " +
      "cycles. Reserve it for things that must change before merge.",
  },
);

export const Finding = Type.Object(
  {
    severity: FindingSeverity,
    severityRationale: Type.String({
      minLength: 1,
      description:
        "One sentence for why this severity and not the next one up or down. `blocking` must name the concrete failure it causes.",
    }),
    file: Type.String({ minLength: 1 }),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    description: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, title: "Finding" },
);

export type Finding = Static<typeof Finding>;

export const ContextContradiction = Type.Object(
  {
    section: Type.Union(
      [
        Type.Literal("decisions"),
        Type.Literal("vocabulary"),
        Type.Literal("non-goals"),
      ],
      { description: "Which agent-proposable section of the product `Context` doc this contradicts." },
    ),
    recorded: Type.String({
      minLength: 1,
      description: "The claim as it appears in the Context doc, quoted.",
    }),
    evidence: Type.String({
      minLength: 1,
      description: "file:line proving the code contradicts it. An assertion with no location is not evidence.",
    }),
  },
  {
    additionalProperties: false,
    title: "ContextContradiction",
    description:
      "This is the only pruning signal the product `Context` doc has (SPEC §4.7) — no sweep, " +
      "no timer. A recorded decision is discovered stale exactly when work contradicts it. " +
      "Empty array is the normal case: never invent a contradiction to fill it, and never " +
      "report a mere gap — something the doc fails to mention — as a contradiction; a gap is " +
      "not a contradiction. The operator resolves the doc as part of this issue; the " +
      "extension does not rewrite the doc from this field.",
  },
);

export type ContextContradiction = Static<typeof ContextContradiction>;

export const CriterionVerification = Type.Object(
  {
    criterion: Type.String({ minLength: 1 }),
    satisfied: Type.Boolean(),
    evidence: Type.String({
      minLength: 1,
      description: "file:line evidence. An assertion with no location is not evidence.",
    }),
  },
  { additionalProperties: false, title: "CriterionVerification" },
);

export const DodCheck = Type.Object(
  {
    item: Type.String({ minLength: 1 }),
    satisfied: Type.Boolean(),
    evidence: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false, title: "DodCheck" },
);

export const ReviewResult = Type.Object(
  {
    issueId: Type.String({ minLength: 1 }),
    reviewedSha: Type.String({
      minLength: 1,
      description:
        "The head SHA you reviewed, taken from the diff you were given. This pins " +
        "the review: a later push invalidates it and triggers re-review.",
    }),
    criteriaVerification: Type.Array(CriterionVerification, {
      description: "One entry per acceptance criterion on the issue.",
    }),
    dodSatisfied: Type.Boolean({
      description:
        "The per-product Definition of Done from the product `Context` doc. That section is " +
        "agent-locked: you grade against it here but cannot propose changes to it — the other " +
        "three sections are proposable via `/foreman:context`.",
    }),
    dodChecklist: Type.Array(DodCheck, {
      description: "Per-item Definition of Done results, for the rendered checklist.",
    }),
    findings: Type.Array(Finding),
    contextContradictions: Type.Array(ContextContradiction),
    projectOrganization: Type.String({
      minLength: 1,
      description:
        "Standing field on every review: structure, module boundaries, naming, " +
        "placement. Say 'no concerns' explicitly rather than leaving it thin.",
    }),
    scopeCreep: Type.Array(Type.String(), {
      description: "Changes outside the acceptance criteria and out-of-scope list.",
    }),
    testAdequacy: Type.String({
      minLength: 1,
      description:
        "Answer by inspection: would these tests fail if the change were reverted?",
    }),
    verdict: Type.Union(
      [
        Type.Literal("approve"),
        Type.Literal("request-changes"),
        Type.Literal("comment"),
      ],
      {
        description:
          "Advisory only — you hold no merge authority. `request-changes` if and " +
          "only if there is at least one `blocking` finding.",
      },
    ),
  },
  { additionalProperties: false, title: "ReviewResult" },
);

export type ReviewResult = Static<typeof ReviewResult>;

export const ReviewOutput = envelope(ReviewResult, "foreman/review-output");
export type ReviewOutput = Static<typeof ReviewOutput>;
