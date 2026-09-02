import { type Static, Type } from "../typebox.ts";
import { TYPE_LABELS } from "../domain/labels.ts";
import { envelope } from "./envelope.ts";

export const CriterionEvidence = Type.Object(
  {
    criterion: Type.String({ minLength: 1 }),
    evidence: Type.String({
      minLength: 1,
      description: "file:line, test name, or command output that shows it holds.",
    }),
  },
  { additionalProperties: false, title: "CriterionEvidence" },
);

export const TestAdded = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    covers: Type.String({
      minLength: 1,
      description: "Which acceptance criterion this test defends.",
    }),
  },
  { additionalProperties: false, title: "TestAdded" },
);

export const DiscoveredWork = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    type: Type.Union(TYPE_LABELS.map((name) => Type.Literal(name))),
    relation: Type.Union([Type.Literal("blocks"), Type.Literal("related")], {
      description:
        "`blocks` only when this issue's work genuinely cannot ship without it. " +
        "Otherwise `related`.",
    }),
  },
  {
    additionalProperties: false,
    title: "DiscoveredWork",
    description:
      "Out-of-scope findings. The extension files these as new Backlog issues with " +
      "native relations — you never create them yourself.",
  },
);

export type DiscoveredWork = Static<typeof DiscoveredWork>;

export const ImplementResult = Type.Object(
  {
    issueId: Type.String({ minLength: 1 }),
    branch: Type.String({
      minLength: 1,
      description: "The branch you pushed. Must match the branch the dispatcher created.",
    }),
    prUrl: Type.String({
      description:
        "The PR you opened. Empty string when the repo sets `pr.required: false` " +
        "and you pushed the branch without opening a PR.",
    }),
    headSha: Type.String({
      minLength: 1,
      description: "The commit you pushed. The review gate pins itself to this.",
    }),
    criteriaMet: Type.Array(CriterionEvidence, {
      description: "One entry per acceptance criterion. The criteria are the contract.",
    }),
    testsAdded: Type.Array(TestAdded, {
      description: "Tests covering each acceptance criterion.",
    }),
    discoveredWork: Type.Array(DiscoveredWork),
    approachSummary: Type.String({
      minLength: 1,
      description: "How you solved it, for the review comment and the PR body.",
    }),
  },
  { additionalProperties: false, title: "ImplementResult" },
);

export type ImplementResult = Static<typeof ImplementResult>;

export const ImplementOutput = envelope(ImplementResult, "foreman/implement-output");
export type ImplementOutput = Static<typeof ImplementOutput>;
