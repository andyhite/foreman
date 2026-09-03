import { type Static, Type } from "../typebox.ts";

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

/**
 * How much the loop may do without asking (SPEC §17.9).
 *
 * Not to be confused with `agent.approvalMode`, which is omp's own approval
 * setting handed to each *dispatched agent's* session. This one governs the
 * supervisor process itself: `confirm` makes the loop ask its operator before
 * every dispatch and every Linear write, `yolo` lets it act on its own
 * decisions. Both happen to spell "act without asking" as `yolo`; they are
 * separate settings at separate layers and neither implies the other.
 */
export const LoopModeSchema = Type.Union([Type.Literal("confirm"), Type.Literal("yolo")], {
  default: "confirm",
});

export const LoopSettingsSchema = Type.Object(
  {
    /**
     * How much this loop may do unattended (SPEC §17.9). Defaults to
     * `confirm`, so a loop started before its operator is ready asks before
     * it acts rather than acting.
     */
    mode: LoopModeSchema,
    /** Full-snapshot poll interval for `foreman plan`/`foreman build`. */
    pollSeconds: Type.Integer({ default: 20, minimum: 5 }),
    /** Per-loop concurrency caps for `foreman plan`/`foreman build`. */
    concurrency: Type.Object(
      {
        plan: Type.Integer({ default: 1, minimum: 1 }),
        build: Type.Integer({ default: 3, minimum: 1 }),
      },
      { additionalProperties: false, default: {} },
    ),
    /** Max inbox issues the plan loop batches into one triage dispatch. */
    triageBatch: Type.Integer({ default: 10, minimum: 1 }),
    /** Loop lockfile and bookkeeping. `~` expands. */
    stateDir: Type.String({ default: "~/.foreman/state", minLength: 1 }),
    /**
     * Remove a merged issue's worktree and close its herdr tab once a
     * `merged-not-done` reconcile fix moves it to Done (SPEC §12). Skipped
     * when the worktree still has uncommitted changes, so this never
     * discards work.
     */
    cleanupMergedWorktrees: Type.Boolean({ default: true }),
  },
  { additionalProperties: false, default: {} },
);

export type LoopSettings = Static<typeof LoopSettingsSchema>;

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
    /**
     * Required to point `endpoint` anywhere but api.linear.app. The API key is
     * sent to whatever host `endpoint` names, so a typo or an edited config is a
     * credential leak unless the operator said so explicitly.
     */
    allowCustomEndpoint: Type.Boolean({ default: false }),
    /**
     * Linear user id to assign an issue to when an agent block needs a human
     * (SPEC §9 Case B) — puts it straight into the operator's own "My
     * Issues" view instead of requiring a `/foreman:status` check. `null`
     * skips assignee-based routing entirely; `foreman:blocked` and the
     * comment still land either way. Distinct from the credential's own
     * identity (`viewerId()`) — when Foreman authenticates as its own
     * dedicated Linear account, this is the human account to hand blocked
     * work back to.
     */
    operatorUserId: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      default: null,
    }),
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
    /** Which dispatcher `foreman plan`/`foreman build` use. `"auto"` prefers herdr when reachable, else print. */
    dispatcher: Type.Union(
      [Type.Literal("auto"), Type.Literal("print"), Type.Literal("herdr")],
      { default: "auto" },
    ),
  },
  { additionalProperties: false, default: {} },
);

export type AgentSettings = Static<typeof AgentSettingsSchema>;

/**
 * Credentials for the GitHub App `foreman-review` submits real PR reviews
 * under (SPEC §7.4). `null`/`null` (the default) leaves reviews
 * Linear-comment-only, exactly as before this existed — both fields must be
 * set together, checked by `resolveGitHubAppCredentials`, since a `gh`-only
 * setup has no App identity to distinguish from whoever opens the PR.
 */
export const GitHubAppSettingsSchema = Type.Object(
  {
    /** The App's numeric id, as a string (SPEC §7.4's `iss` claim). */
    appId: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { default: null }),
    /** File holding the App's PEM private key, used to sign the JWT that mints installation tokens. */
    privateKeyFile: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { default: null }),
  },
  { additionalProperties: false, default: {} },
);

export type GitHubAppSettings = Static<typeof GitHubAppSettingsSchema>;

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
 * positional alias argument to `foreman repo`, the herdr workspace name, and
 * the state-dir segment.
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
    linear: LinearSettingsSchema,
    githubApp: GitHubAppSettingsSchema,
    agent: AgentSettingsSchema,
    /** Inherited by every `repos` entry. */
    repoDefaults: RepoSettingsSchema,
    /**
     * Alias → entry. The single table binding repos to teams and initiatives —
     * instances resolve their own scope from it by cwd (SPEC §3.10, §3.11).
     */
    repos: Type.Record(Type.String({ minLength: 1 }), RepoEntrySchema, {
      default: {},
    }),
  },
  { additionalProperties: false, default: {} },
);

export type GlobalConfig = Static<typeof GlobalConfigSchema>;
