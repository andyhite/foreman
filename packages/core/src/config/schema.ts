import { type Static, Type } from "@sinclair/typebox";

/**
 * `.foreman/config.json` (SPEC §3.10).
 *
 * Two layers, deep-merged, repo wins. Every number quoted elsewhere in the spec
 * is a default defined here, not a constant.
 *
 * `additionalProperties: false` everywhere is deliberate: a typo that silently
 * falls back to a default is the config-file equivalent of `autoload-skills`
 * dropping an unknown skill name without a warning.
 */

/** Per-repo settings. Also the shape of the global `repoDefaults` block. */
export const RepoSettingsSchema = Type.Object(
  {
    baseBranch: Type.String({ default: "main", minLength: 1 }),
    pr: Type.Object(
      {
        required: Type.Boolean({ default: true }),
        draft: Type.Boolean({ default: false }),
        ciRequired: Type.Boolean({ default: true }),
      },
      { additionalProperties: false, default: {} },
    ),
    merge: Type.Object(
      {
        strategy: Type.Union(
          [Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")],
          { default: "squash" },
        ),
        deleteBranch: Type.Boolean({ default: true }),
      },
      { additionalProperties: false, default: {} },
    ),
    /** Tokens: `<issue-id>` (lowercased identifier), `<slug>`, `<ISSUE-ID>`, `<repo>`. */
    branchPattern: Type.String({ default: "<issue-id>-<slug>", minLength: 1 }),
    /** Resolved relative to the repo directory. */
    worktreePattern: Type.String({ default: "../<repo>-<ISSUE-ID>", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type RepoSettings = Static<typeof RepoSettingsSchema>;

export const LoopSettingsSchema = Type.Object(
  {
    /** Global cap on concurrent agents. This is the one that protects you (SPEC §17.6). */
    wipGlobal: Type.Integer({ default: 3, minimum: 1 }),
    wip: Type.Object(
      {
        triage: Type.Integer({ default: 1, minimum: 1 }),
        refine: Type.Integer({ default: 2, minimum: 1 }),
        implement: Type.Integer({ default: 3, minimum: 1 }),
        review: Type.Integer({ default: 2, minimum: 1 }),
      },
      { additionalProperties: false, default: {} },
    ),
    /** Refine targets a buffer depth in the Ready view, not a WIP count (SPEC §17.6). */
    readyBufferTarget: Type.Integer({ default: 5, minimum: 1 }),
    /**
     * Blocked-queue depth at which every worker stops dispatching (SPEC §17.7).
     * `0` means "no new dispatches while anything is blocked" — never "off".
     */
    backpressureThreshold: Type.Integer({ default: 5, minimum: 0 }),
    retryCap: Type.Integer({ default: 2, minimum: 1 }),
    reviewCycleCap: Type.Integer({ default: 2, minimum: 1 }),
    cadenceMinutes: Type.Integer({ default: 5, minimum: 1 }),
    /** Local time-of-day window in which the daily triage batch may start. */
    triageWindow: Type.String({ default: "06:00", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    /**
     * Autonomy staging (SPEC §17.9). Defaults to the safest rung, so a loop
     * started before its operator is ready logs instead of dispatching.
     */
    stage: Type.Union(
      [
        Type.Literal("dry-run"),
        Type.Literal("read-only"),
        Type.Literal("full"),
      ],
      { default: "dry-run" },
    ),
    dispatcher: Type.Union([Type.Literal("print"), Type.Literal("herdr")], {
      default: "print",
    }),
    /**
     * Poll merged PRs and move issues to Done. Required when `pr.required` is
     * false, and on by default regardless: Linear's GitHub integration only
     * auto-transitions when a team workflow automation has been configured for it.
     */
    mergeDetection: Type.Boolean({ default: true }),
    /** Loop lockfile and bookkeeping. `~` expands. */
    stateDir: Type.String({ default: "~/.foreman/state", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type LoopSettings = Static<typeof LoopSettingsSchema>;

export const TriageSettingsSchema = Type.Object(
  {
    /** Un-actioned `Low` items older than this are proposed for cancellation. */
    staleLowDays: Type.Integer({ default: 90, minimum: 1 }),
    /** Inbox items handed to one triage batch. */
    batchSize: Type.Integer({ default: 20, minimum: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type TriageSettings = Static<typeof TriageSettingsSchema>;

export const LinearSettingsSchema = Type.Object(
  {
    /** Env var holding the personal API key. Checked first. */
    apiKeyEnv: Type.String({ default: "LINEAR_API_KEY", minLength: 1 }),
    /**
     * File holding the key, one line. Checked when the env var is unset — this is
     * where a herdr-hosted board reads it from, since `HERDR_PLUGIN_CONFIG_DIR`
     * survives a plugin reinstall and the managed checkout does not (SPEC §17.4).
     */
    apiKeyFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      default: null,
    }),
    /** Team keys Foreman manages, e.g. `["ENG"]`. Empty means every team. */
    teamKeys: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
    endpoint: Type.String({ default: "https://api.linear.app/graphql", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type LinearSettings = Static<typeof LinearSettingsSchema>;

export const AgentSettingsSchema = Type.Object(
  {
    /**
     * Mirror of omp's `task.maxRuntimeMs`. Foreman cannot read omp settings from
     * the loop process, and the lock TTL derives from this cap (SPEC §11).
     */
    maxRuntimeMs: Type.Integer({ default: 7_200_000, minimum: 60_000 }),
    /** Lock TTL is `2 × maxRuntimeMs + this`. Default puts it at ~4.5 h. */
    lockTtlMarginMs: Type.Integer({ default: 1_800_000, minimum: 0 }),
    /** Absolute path to the omp binary used by `PrintDispatcher`. */
    ompBin: Type.String({ default: "omp", minLength: 1 }),
    /**
     * Approval mode passed explicitly to every dispatched parent session. The
     * print-mode parent is a second interrupt surface and stalls headless at
     * defaults (SPEC §17.2, §17.3).
     */
    approvalMode: Type.String({ default: "yolo", minLength: 1 }),
    herdrBin: Type.String({ default: "herdr", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type AgentSettings = Static<typeof AgentSettingsSchema>;

/** `~/.foreman/config.json`. */
export const GlobalConfigSchema = Type.Object(
  {
    /** Linear project id → repo path. The only place Foreman learns this (SPEC §3.5). */
    projects: Type.Record(Type.String(), Type.String({ minLength: 1 }), {
      default: {},
    }),
    loop: LoopSettingsSchema,
    triage: TriageSettingsSchema,
    linear: LinearSettingsSchema,
    agent: AgentSettingsSchema,
    repoDefaults: RepoSettingsSchema,
  },
  { additionalProperties: false, default: {} },
);

export type GlobalConfig = Static<typeof GlobalConfigSchema>;

/** `<repo>/.foreman/config.json` — repo keys only, versioned with the code they govern. */
export const RepoConfigFileSchema = Type.Partial(RepoSettingsSchema, {
  additionalProperties: false,
});

export type RepoConfigFile = Static<typeof RepoConfigFileSchema>;
