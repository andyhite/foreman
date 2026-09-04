import { type Static, Type } from "../typebox.ts";
import { TYPE_LABELS } from "../domain/labels.ts";
import { envelope } from "./envelope.ts";
import { EstimateSchema } from "./refine.ts";

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
      minimum: 1,
      maximum: 4,
      description: "1 Urgent, 2 High, 3 Medium, 4 Low.",
    }),
    app: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "App this issue belongs to, matching one of the repo's configured apps (the FOREMAN-APPS " +
        "marker lists them). Null when the repo has no apps or the issue spans all of them.",
    }),
    severityReasoning: Type.String({
      minLength: 1,
      description:
        "Why that priority. This is the tuning log for the dedupe and severity " +
        "thresholds — write it for a reader deciding whether you were right.",
    }),
    destination: Type.Union(
      [
        Type.Literal("backlog"),
        Type.Literal("new-project"),
        Type.Literal("cancel"),
        Type.Literal("duplicate"),
      ],
      { description: "Where this issue moves on triage — applied directly, not proposed for later approval." },
    ),
    destinationProjectId: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "Linear project id to file this issue under. Required (non-null) when `destination` is \"backlog\"; null otherwise.",
    }),
    newProject: Type.Union(
      [
        Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            description: Type.String({ minLength: 1 }),
            app: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
              description: "App label for the new project. Null when the repo has no apps.",
            }),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ],
      {
        description: "The project to create for this issue. Required (non-null) when `destination` is \"new-project\"; null otherwise.",
      },
    ),
    duplicateOf: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "Human identifier of the issue this duplicates. Required (non-null) when `destination` is \"duplicate\"; null otherwise.",
    }),
    proposedBlockedBy: Type.Array(Type.String(), {
      description:
        "Human identifiers of issues that block this one. Native Linear relations, " +
        "never labels.",
    }),
    draftDescription: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "Drafted issue body when the source Inbox item lacks one; applied directly. Null when the existing description is adequate.",
    }),
    proposedEstimate: Type.Union([EstimateSchema, Type.Null()], {
      description: "Estimate to apply, or null when you cannot yet estimate it.",
    }),
    missingInfo: Type.Array(Type.String(), {
      description: "What a human would have to add before this is refinable.",
    }),
  },
  { additionalProperties: false, title: "TriageItem" },
);

export type TriageItem = Static<typeof TriageItem>;

export const TriageResult = Type.Object(
  {
    items: Type.Array(TriageItem, {
      description: "One entry per issue in the Inbox batch you processed.",
    }),
    summary: Type.String({
      minLength: 1,
      description: "One paragraph on the batch as a whole: patterns, surprises, dedupe calls.",
    }),
  },
  { additionalProperties: false, title: "TriageResult" },
);

export type TriageResult = Static<typeof TriageResult>;

export const TriageOutput = envelope(TriageResult, "foreman/triage-output");
export type TriageOutput = Static<typeof TriageOutput>;
