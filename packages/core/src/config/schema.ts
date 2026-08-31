import { type Static, Type } from "@sinclair/typebox";

/**
 * `~/.foreman/config.json` (SPEC §3.10).
 *
 * One global file, no per-repo config: the `repos` registry is the single
 * table binding repos to teams and initiatives, so both consumers share one
 * lookup. Every number quoted elsewhere in the spec is a default defined
 * here, not a constant.
 *
 * `additionalProperties: false` everywhere is deliberate: a typo that silently
 * falls back to a default is the config-file equivalent of `autoload-skills`
 * dropping an unknown skill name without a warning.
 */

export const PrSettingsSchema = Type.Object(
  {
    required: Type.Boolean({ default: true }),
    draft: Type.Boolean({ default: false }),
    ciRequired: Type.Boolean({ default: true }),
  },
  { additionalProperties: false, default: {} },
);

export const MergeSettingsSchema = Type.Object(
  {
    strategy: Type.Union(
      [Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")],
      { default: "squash" },
    ),
    deleteBranch: Type.Boolean({ default: true }),
  },
  { additionalProperties: false, default: {} },
);

/** The fully-populated shape: the `repoDefaults` block, and what consumers receive after merging. */
export const RepoSettingsSchema = Type.Object(
  {
    baseBranch: Type.String({ default: "main", minLength: 1 }),
    pr: PrSettingsSchema,
    merge: MergeSettingsSchema,
    /** Tokens: `<issue-id>` (lowercased identifier), `<slug>`, `<ISSUE-ID>`, `<repo>`. */
    branchPattern: Type.String({ default: "<issue-id>-<slug>", minLength: 1 }),
    /** Resolved relative to the repo directory. */
    worktreePattern: Type.String({ default: "../<repo>-<ISSUE-ID>", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type RepoSettings = Static<typeof RepoSettingsSchema>;

/**
 * What a registry entry may override. Deliberately *deep*-partial: a plain
 * `Type.Partial(RepoSettingsSchema)` makes only the top-level keys optional,
 * so `"pr": { "required": false }` — the override the spec itself gives as the
 * example (SPEC §3.10) — would fail for the missing `draft` and `ciRequired`.
 *
 * No `default` on any member: an override is distinguishable from "inherit"
 * only by being absent, and `mergeRepoSettings` spreads these over the
 * defaults key-by-key.
 */
export const RepoSettingsOverrideSchema = Type.Object(
  {
    baseBranch: Type.Optional(Type.String({ minLength: 1 })),
    pr: Type.Optional(Type.Partial(PrSettingsSchema, { additionalProperties: false })),
    merge: Type.Optional(Type.Partial(MergeSettingsSchema, { additionalProperties: false })),
    branchPattern: Type.Optional(Type.String({ minLength: 1 })),
    worktreePattern: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type RepoSettingsOverride = Static<typeof RepoSettingsOverrideSchema>;

const LoopStageValueSchema = Type.Union([
  Type.Literal("dry-run"),
  Type.Literal("read-only"),
  Type.Literal("full"),
]);

export const LoopStageSchema = Type.Union(
  [Type.Literal("dry-run"), Type.Literal("read-only"), Type.Literal("full")],
  { default: "dry-run" },
);
/** Optional per-worker autonomy overrides; omitted workers inherit `loop.stage`. */
export const WorkerStagesSchema = Type.Partial(
  Type.Object(
    {
      plan: LoopStageValueSchema,
      refine: LoopStageValueSchema,
      implement: LoopStageValueSchema,
      review: LoopStageValueSchema,
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false, default: {} },
);

export const LoopSettingsSchema = Type.Object(
  {
    /** Global cap on concurrent agents. This is the one that protects you (SPEC §17.6). */
    wipGlobal: Type.Integer({ default: 3, minimum: 1 }),
    wip: Type.Object(
      {
        refine: Type.Integer({ default: 2, minimum: 1 }),
        implement: Type.Integer({ default: 3, minimum: 1 }),
        review: Type.Integer({ default: 2, minimum: 1 }),
        /** Planning is coarser and rarer than the other three stages — one project decomposition at a time by default. */
        plan: Type.Integer({ default: 1, minimum: 1 }),
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
    /**
     * Autonomy staging (SPEC §17.9). Defaults to the safest rung, so a loop
     * started before its operator is ready logs instead of dispatching.
     */
    stage: LoopStageSchema,
    /**
     * Per-worker autonomy overrides. A missing key retains the global
     * `loop.stage` fallback, allowing workers to be enabled independently.
     */
    workerStages: WorkerStagesSchema,
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

/** The team-level intake process (SPEC §3.12). */
export const IntakeSettingsSchema = Type.Object(
  {
    /** Local time-of-day window in which the daily intake batch may start. */
    window: Type.String({ default: "06:00", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    /** Un-actioned `Low` items older than this are proposed for cancellation. */
    staleLowDays: Type.Integer({ default: 90, minimum: 1 }),
    /** Inbox items handed to one triage batch. */
    batchSize: Type.Integer({ default: 20, minimum: 1 }),
    /** IANA zone name `pastIntakeWindow` compares `window` against. Defaults to the host zone at load time. */
    timezone: Type.String({ default: Intl.DateTimeFormat().resolvedOptions().timeZone, minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type IntakeSettings = Static<typeof IntakeSettingsSchema>;

export const LinearSettingsSchema = Type.Object(
  {
    /** Env var holding the personal API key. Checked first. */
    apiKeyEnv: Type.String({ default: "LINEAR_API_KEY", minLength: 1 }),
    /**
     * File holding the key, one line. Checked when the env var is unset —
     * useful for a config-file-only deployment where the env var isn't set.
     */
    apiKeyFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      default: null,
    }),
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
    approvalMode: Type.Union(
      [Type.Literal("always-ask"), Type.Literal("write"), Type.Literal("yolo")],
      { default: "yolo" },
    ),
    herdrBin: Type.String({ default: "herdr", minLength: 1 }),
  },
  { additionalProperties: false, default: {} },
);

export type AgentSettings = Static<typeof AgentSettingsSchema>;

/**
 * One initiative bound to a repo: a bare initiative ID, or an ID plus the
 * subdirectory hosting that app. The path hint feeds context assembly and
 * implement's initial reads, and only means anything for a monorepo binding
 * several initiatives (SPEC §3.10, §3.11).
 *
 * IDs, never names — grouping prefixes rename (SPEC §3.5 item 6).
 */
export const InitiativeBindingSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      id: Type.String({ minLength: 1 }),
      /** Relative to the entry's `path`. */
      path: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type InitiativeBinding = Static<typeof InitiativeBindingSchema>;

/**
 * One `repos` registry entry, keyed by alias (SPEC §3.10). The alias is the
 * `--repo` argument, the herdr workspace name, and the state-dir segment.
 *
 * Carries optional `RepoSettings` overrides that deep-merge over
 * `repoDefaults`, entry wins. Those overrides MUST stay sparse: they are
 * distinguishable from "inherit the default" only by being absent. This holds
 * because `repos` is a `Type.Record`, and `Value.Default` does not recurse
 * into record values — so never call `Value.Default` on this schema directly,
 * or every entry silently acquires a full set of defaults and `repoDefaults`
 * stops winning anything.
 */
export const RepoEntrySchema = Type.Composite(
  [
    Type.Object(
      {
        /** Repo root. `~` expands. Matched against cwd to resolve the instance (SPEC §3.11). */
        path: Type.String({ minLength: 1 }),
        /** Linear team key. Optional when the credential reaches exactly one team (SPEC §3.11). */
        team: Type.Optional(Type.String({ minLength: 1 })),
        /** One or more; a monorepo lists several. */
        initiatives: Type.Array(InitiativeBindingSchema, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    RepoSettingsOverrideSchema,
  ],
  { additionalProperties: false },
);

export type RepoEntry = Static<typeof RepoEntrySchema>;

/** `~/.foreman/config.json` — the only config file (SPEC §3.10). */
export const GlobalConfigSchema = Type.Object(
  {
    loop: LoopSettingsSchema,
    intake: IntakeSettingsSchema,
    linear: LinearSettingsSchema,
    agent: AgentSettingsSchema,
    /** Inherited by every `repos` entry. */
    repoDefaults: RepoSettingsSchema,
    /**
     * Alias → entry. The single table binding repos to teams and initiatives:
     * instances resolve their own scope from it by cwd, intake inverts it in
     * memory for initiative→repo (SPEC §3.10, §3.11, §3.12).
     */
    repos: Type.Record(Type.String({ minLength: 1 }), RepoEntrySchema, {
      default: {},
    }),
  },
  { additionalProperties: false, default: {} },
);

export type GlobalConfig = Static<typeof GlobalConfigSchema>;
