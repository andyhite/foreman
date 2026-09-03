import { type Static, type TSchema, Type } from "../typebox.ts";

/**
 * BlockRecord — returned by any agent *instead of* its normal result (SPEC §6, §9).
 *
 * Writing the confusion down is the point: a vague BlockRecord is a signal that
 * the issue was under-refined, which is diagnostic information about refine.
 */
export const BlockRecord = Type.Object(
  {
    blocked: Type.Literal(true),
    type: Type.Union(
      [
        Type.Literal("dependency"),
        Type.Literal("needs-input"),
        Type.Literal("needs-decision"),
        Type.Literal("external"),
        Type.Literal("budget"),
      ],
      {
        description:
          "`dependency` is Case A (SPEC §9): another issue blocks this one, so no " +
          "`foreman:blocked` label is applied and the native relation is the state. " +
          "Everything else is Case B and parks the issue in the human queue.",
      },
    ),
    whatIWasDoing: Type.String({
      minLength: 1,
      description: "Where the run stopped, in enough detail to resume from.",
    }),
    whatINeed: Type.String({
      minLength: 1,
      description: "The single question or decision that unblocks this.",
    }),
    options: Type.Union([
      Type.Array(
        Type.Object(
          {
            label: Type.String({ minLength: 1 }),
            tradeoff: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
      Type.Null(),
    ]),
    recommendation: Type.Union([Type.String(), Type.Null()], {
      description: "Which option you would pick, and why. Null only when you truly have no lean.",
    }),
    stateLeftBehind: Type.Object(
      {
        worktree: Type.Union([Type.String(), Type.Null()]),
        branch: Type.Union([Type.String(), Type.Null()]),
        pushed: Type.Boolean(),
        commits: Type.Array(Type.String()),
        notes: Type.String(),
      },
      { additionalProperties: false },
    ),
    costOfWrongGuess: Type.String({
      minLength: 1,
      description: "What it costs if you guess instead of asking. This is why you blocked.",
    }),
    blockedByIssues: Type.Array(Type.String(), {
      description:
        "Human identifiers (e.g. ENG-142) of issues that block this one. " +
        "Required and non-empty when `type` is `dependency`; empty otherwise.",
    }),
  },
  {
    $id: "foreman/block-record",
    additionalProperties: false,
    title: "BlockRecord",
  },
);

export type BlockRecord = Static<typeof BlockRecord>;

/**
 * Every agent's `output` schema is this envelope.
 *
 * SPEC §6 calls for "a union of the normal result and BlockRecord", discriminated
 * on `blocked`. A literal root-level union is the wrong encoding for the runtime:
 * omp's schema normalizer collapses a residual root `anyOf` to
 * `{ type: "object", properties: {} }` on the Google and Cloud-Code-Assist paths,
 * which silently discards the entire contract. An envelope with a required
 * discriminator and two nullable branches survives every normalizer, keeps the
 * discriminated-union semantics the extension branches on, and moves the
 * "exactly one branch is populated" check into `parseAgentOutput`, where a
 * violation is a named error instead of a shrug.
 */
export function envelope<T extends TSchema>(result: T, id: string) {
  return Type.Object(
    {
      blocked: Type.Boolean({
        description:
          "False for a normal result, true when you are blocked. Set it first, " +
          "then populate exactly one of `result` / `block` and null the other.",
      }),
      result: Type.Union([result, Type.Null()], {
        description: "The normal result. Null if and only if `blocked` is true.",
      }),
      block: Type.Union([BlockRecord, Type.Null()], {
        description: "The block record. Null if and only if `blocked` is false.",
      }),
    },
    { $id: id, additionalProperties: false },
  );
}
