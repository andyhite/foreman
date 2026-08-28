import { type Static, Type } from "@sinclair/typebox";
import { TYPE_LABELS } from "../domain/labels.ts";
import { envelope } from "./envelope.ts";

const TypeLabelSchema = Type.Union(
  TYPE_LABELS.map((name) => Type.Literal(name)),
  { description: "The `type:` label this issue should carry when it leaves Triage." },
);

export const TriageItem = Type.Object(
  {
    issueId: Type.String({
      minLength: 1,
      description: "Human identifier, e.g. ENG-142.",
    }),
    type: TypeLabelSchema,
    proposedPriority: Type.Integer({
      minimum: 0,
      maximum: 4,
      description:
        "0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. Propose 0 only when you " +
        "genuinely cannot tell; 0 makes the issue ineligible for refinement.",
    }),
    severityReasoning: Type.String({
      minLength: 1,
      description:
        "Why that priority. This is the tuning log for the dedupe and severity " +
        "thresholds — write it for a reader deciding whether you were right.",
    }),
    duplicateOf: Type.Union([Type.String(), Type.Null()], {
      description: "Human identifier of the issue this duplicates, or null.",
    }),
    proposedBlockedBy: Type.Array(Type.String(), {
      description:
        "Human identifiers of issues that block this one. Native Linear relations, " +
        "never labels.",
    }),
    destination: Type.Union(
      [
        Type.Literal("Backlog"),
        Type.Literal("Canceled"),
        Type.Literal("Duplicate"),
      ],
      { description: "Where this issue should move once the proposal is approved." },
    ),
    reproConfidence: Type.Union(
      [
        Type.Literal("confirmed"),
        Type.Literal("likely"),
        Type.Literal("cannot-reproduce"),
        Type.Literal("not-attempted"),
      ],
      {
        description:
          "Repro is attempted by reading only — you hold no exec tool. " +
          "`not-attempted` is correct for anything that is not a bug.",
      },
    ),
    missingInfo: Type.Array(Type.String(), {
      description: "What a human would have to add before this is refinable.",
    }),
    triageLabel: Type.Union(
      [
        Type.Literal("triage:cannot-reproduce"),
        Type.Literal("triage:duplicate"),
        Type.Literal("triage:needs-info"),
        Type.Literal("triage:wont-fix"),
        Type.Null(),
      ],
      { description: "Optional triage disposition label, or null." },
    ),
  },
  { additionalProperties: false, title: "TriageItem" },
);

export type TriageItem = Static<typeof TriageItem>;

export const TriageProposal = Type.Object(
  {
    items: Type.Array(TriageItem, {
      description: "One entry per issue in the Inbox batch you processed.",
    }),
    summary: Type.String({
      minLength: 1,
      description: "One paragraph on the batch as a whole: patterns, surprises, dedupe calls.",
    }),
  },
  { additionalProperties: false, title: "TriageProposal" },
);

export type TriageProposal = Static<typeof TriageProposal>;

export const TriageOutput = envelope(TriageProposal, "foreman/triage-output");
export type TriageOutput = Static<typeof TriageOutput>;
