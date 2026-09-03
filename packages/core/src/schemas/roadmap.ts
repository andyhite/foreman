import { type Static, Type } from "../typebox.ts";
import { envelope } from "./envelope.ts";

/**
 * Linear's `TimelessDate` — a calendar day with no time or zone. The API
 * rejects a full timestamp on `Project.startDate`/`targetDate`, so the
 * pattern is enforced here rather than discovered at mutation time.
 */
const TimelessDateSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Calendar day, `YYYY-MM-DD`. Not a timestamp — Linear rejects one.",
});

export const ProposedProject = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      description:
        "A short identifier for this proposal, unique within this result and referenced by " +
        "other entries' `blockedBy`. Local to the result only — Linear assigns the real id.",
    }),
    name: Type.String({
      minLength: 1,
      description: "The project name as it will read in Linear's sidebar. A shippable increment, not a theme.",
    }),
    description: Type.String({
      minLength: 1,
      description: "Linear's one-line summary. Orientation for someone scanning the initiative, not the brief.",
    }),
    brief: Type.String({
      minLength: 1,
      description:
        "The project brief (SPEC §4.7) in markdown, written to the project's `content` — the " +
        "field Linear's UI shows as the project overview, and the document `foreman-plan` " +
        "later decomposes into issues. Without it a created project is unplannable.",
    }),
    blockedBy: Type.Array(Type.String(), {
      description:
        "`key`s of other entries in this same result that must finish before this project " +
        "starts. The extension creates a native `dependency` relation for each, which is what " +
        "keeps the plan worker off this project until its prerequisites ship (SPEC §17.5).",
    }),
    blockedByExisting: Type.Array(Type.String(), {
      description:
        "Ids of projects that already exist in Linear and must finish before this one starts. " +
        "Same relation, one end of which is not being created by this result.",
    }),
    startDate: TimelessDateSchema,
    targetDate: TimelessDateSchema,
    app: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "App label for this project. Null when the repo has no apps.",
    }),
  },
  { additionalProperties: false, title: "ProposedProject" },
);

export type ProposedProject = Static<typeof ProposedProject>;

export const RoadmapResult = Type.Object(
  {
    teamId: Type.String({
      minLength: 1,
      description: "The Linear team every proposed project is created under — this repo's team.",
    }),
    proposedProjects: Type.Array(ProposedProject, {
      minItems: 1,
      description:
        "The projects to create, in no particular array order — `blockedBy` carries the " +
        "sequence, not position. The extension creates each one, attaches it to the " +
        "initiative, sets its dates, and wires its dependency edges.",
    }),
    sourceDocument: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "Repo-relative path of the brief/PRD/spec you decomposed, or null when you worked from the repo's own docs.",
    }),
    rationale: Type.String({
      minLength: 1,
      description:
        "Why this decomposition and this sequence, including what the dates were derived from. " +
        "Logged for the operator, never written to Linear.",
    }),
  },
  { additionalProperties: false, title: "RoadmapResult" },
);

export type RoadmapResult = Static<typeof RoadmapResult>;

export const RoadmapOutput = envelope(RoadmapResult, "foreman/roadmap-output");
export type RoadmapOutput = Static<typeof RoadmapOutput>;
