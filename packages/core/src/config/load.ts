import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { GitHubAppCredentials } from "../github/app-auth.ts";
import { Value } from "../typebox.ts";
import {
  type AppBinding,
  type GlobalConfig,
  GlobalConfigSchema,
  type RepoEntry,
  type RepoSettings,
  type RepoSettingsOverride,
} from "./schema.ts";

/** Raised on any config problem the operator must fix before Foreman proceeds (SPEC §3.10). */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[]) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadedConfig {
  config: GlobalConfig;
  /** Config files actually read, in load order. */
  sources: string[];
  warnings: string[];
}

/**
 * A registry entry with `repoDefaults` already merged in and its bindings
 * flattened — what every consumer actually wants (SPEC §3.10, §3.11).
 */
export type ResolvedRepoEntry = RepoSettings & {
  /** Registry key: the positional alias argument to `foreman build`/`foreman plan`/`foreman reconcile`, herdr workspace name, and state-dir segment. */
  alias: string;
  /** Absolute, `~`-expanded. */
  repoPath: string;
  /** Linear team key this repo is bound to. */
  team: string;
  /** Monorepo app bindings; empty for a single-app repo. */
  apps: AppBinding[];
  /** `apps.map(a => a.name)`, derived once. */
  appNames: string[];
};

/**
 * Canonical absolute path, symlinks resolved, for a path that may not exist.
 *
 * A plain `realpathSync` throws on a missing path, and falling back to the raw
 * input is not good enough: on macOS an existing `/var/...` canonicalizes to
 * `/private/var/...`, so comparing a resolved path against an unresolved one
 * never matches. That breaks cwd matching in both directions — a cwd below a
 * repo that has no such subdirectory on disk, and a registry entry whose repo
 * is not cloned yet.
 *
 * So: resolve the longest existing ancestor, then re-append the remainder.
 */
function canonicalPath(p: string): string {
  const absolute = resolve(p);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = realpathSync(head);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Rejects a Linear team bound in two registry entries (SPEC §3.10). The split
 * per-repo files could not catch this — no single instance could see the
 * collision — so it is checked once, here, at load.
 */
function assertTeamsUnique(config: GlobalConfig, describeFor: string): void {
  const ownerByTeam: Record<string, string> = {};
  const problems: string[] = [];
  for (const alias of Object.keys(config.repos)) {
    const team = config.repos[alias]!.team;
    const key = team.toLowerCase();
    const owner = ownerByTeam[key];
    if (owner !== undefined) {
      problems.push(`team ${team} is bound to both repos.${owner} and repos.${alias}`);
      continue;
    }
    ownerByTeam[key] = alias;
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid global config at ${describeFor}`, problems);
  }
}

/** Rejects a `repos` alias that is empty, whitespace-only, or contains a path/label-hostile character (SPEC §3.10): the alias is also the positional alias argument to `foreman build`/`foreman plan`/`foreman reconcile`, the herdr workspace label, and a state-directory segment. */
function assertRepoAliasesValid(config: GlobalConfig, describeFor: string): void {
  const problems: string[] = [];
  for (const alias of Object.keys(config.repos)) {
    if (alias.trim().length === 0) {
      problems.push(`repos key ${JSON.stringify(alias)} must not be empty or whitespace-only`);
    } else if (alias === "." || alias === ".." || /[:/\\]/.test(alias)) {
      problems.push(`repos key ${JSON.stringify(alias)} must not contain ":", "/", or "\\"`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid global config at ${describeFor}`, problems);
  }
}


/** `~` expands to `home` (default `os.homedir()`); any other path is returned unchanged. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Formats TypeBox validation errors as `<pointer>: <message>` strings, one per
 * failure, so a typo names exactly the key and file it came from (SPEC §3.10).
 */
function formatValidationErrors(schema: Parameters<typeof Value.Errors>[0], value: unknown): string[] {
  const problems: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    const pointer = error.path === "" ? "/" : error.path;
    problems.push(`${pointer}: ${error.message}`);
  }
  return problems;
}

/**
 * Rejects a pre-team-per-repo config (SPEC §3.10): a `repos.<alias>` entry
 * still carrying an `initiatives` key, or missing `team`, predates this
 * mapping and cannot be auto-migrated — a repo's team must be chosen, not
 * guessed. Runs on the raw parsed JSON, before `Value.Default`/`Value.Check`,
 * so the operator sees this message instead of an opaque TypeBox error.
 */
function assertNotStaleConfig(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const repos = (value as Record<string, unknown>).repos;
  if (typeof repos !== "object" || repos === null) return;
  for (const [alias, rawEntry] of Object.entries(repos as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    if ("initiatives" in entry || typeof entry.team !== "string") {
      const path = typeof entry.path === "string" ? entry.path : alias;
      throw new ConfigError(`repos.${alias} predates the team-per-repo mapping`, [
        "a repo now binds exactly one Linear team and its apps, not initiatives",
        `re-run \`foreman init\` in ${path} to rewrite the entry`,
      ]);
    }
  }

}

function readJsonFile(path: string, describeFor: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to read ${describeFor} at ${path}: ${(error as Error).message}`, [
      (error as Error).message,
    ]);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Failed to parse ${describeFor} at ${path} as JSON`, [(error as Error).message]);
  }
}

/**
 * Applies `GlobalConfigSchema` defaults to `value` and validates the result,
 * throwing `ConfigError` (labeled with `describeFor`, e.g. a file path) on
 * failure. Shared by `loadGlobalConfig` and any writer that needs to know a
 * patch produces a valid config before it touches disk (e.g. `foreman setup`).
 */
export function defaultAndValidateGlobalConfig(value: unknown, describeFor: string): GlobalConfig {
  assertNotStaleConfig(value);
  const defaulted = Value.Default(GlobalConfigSchema, value);
  if (!Value.Check(GlobalConfigSchema, defaulted)) {
    const problems = formatValidationErrors(GlobalConfigSchema, defaulted);
    throw new ConfigError(`Invalid global config${describeFor ? ` at ${describeFor}` : ""}`, problems);
  }
  const config = defaulted as GlobalConfig;
  assertRepoAliasesValid(config, describeFor);
  assertTeamsUnique(config, describeFor);
  assertEndpointHostAllowed(config);
  return config;
}

/**
 * Refuses a `linear.endpoint` whose host is not `api.linear.app` unless
 * `linear.allowCustomEndpoint` opts in — the credential would otherwise be
 * sent to an arbitrary host. Applies to every loader (the three loop CLIs
 * and the plugin runtime), not just the CLIs that used to check this alone.
 */
function assertEndpointHostAllowed(config: GlobalConfig): void {
  let endpointHost: string;
  try {
    endpointHost = new URL(config.linear.endpoint).host;
  } catch {
    endpointHost = "";
  }
  if (endpointHost !== "api.linear.app" && endpointHost !== "" && !config.linear.allowCustomEndpoint) {
    throw new ConfigError(
      `linear.endpoint is ${config.linear.endpoint}, not https://api.linear.app/graphql — the API key would be sent there.`,
      ["Set linear.allowCustomEndpoint: true in ~/.foreman/config.json if this is deliberate."],
    );
  }
}

/**
 * Loads and validates `<home>/.foreman/config.json` (SPEC §3.10). A missing
 * file is fine — it's the state of a fresh install — and yields a fully
 * defaulted config plus a warning. An unparseable or schema-invalid file
 * throws `ConfigError`: a typo must fail loudly rather than silently fall
 * back to a default.
 */
export function loadGlobalConfig(options?: {
  home?: string;
  env?: Record<string, string | undefined>;
}): LoadedConfig {
  const home = options?.home ?? homedir();
  const path = join(home, ".foreman", "config.json");
  const warnings: string[] = [];
  const sources: string[] = [];

  let parsed: unknown = {};
  if (existsSync(path)) {
    parsed = readJsonFile(path, "global config");
    sources.push(path);
  } else {
    warnings.push(`No global config found at ${path}; using defaults.`);
  }

  const config = defaultAndValidateGlobalConfig(parsed, path);
  if (Object.keys(config.repos).length === 0) {
    warnings.push("No entries in config.repos; no repo is Foreman-managed yet.");
  }

  return { config, sources, warnings };
}

/**
 * Deep-merges two settings objects key-by-key at the object-value level (not
 * whole-object replacement), so a repo overriding only `pr.draft` keeps the
 * default `pr.required` (SPEC §3.10).
 */
function mergeRepoSettings(base: RepoSettings, override: RepoSettingsOverride): RepoSettings {
  return {
    baseBranch: override.baseBranch ?? base.baseBranch,
    pr: { ...base.pr, ...override.pr },
    merge: { ...base.merge, ...override.merge },
    branchPattern: override.branchPattern ?? base.branchPattern,
    worktreePattern: override.worktreePattern ?? base.worktreePattern,
  };
}


/**
 * Resolves the registry entry for `alias`: `config.repoDefaults` deep-merged
 * with the entry's own overrides, entry winning (SPEC §3.10). The returned
 * `repoPath` is `~`-expanded and absolute.
 */
export function resolveRepoEntry(config: GlobalConfig, alias: string, home?: string): ResolvedRepoEntry {
  const entry = config.repos[alias];
  if (entry === undefined) {
    throw new ConfigError(`No repos entry named "${alias}"`, [
      `repos.${alias} is unset; add it to ${join(home ?? homedir(), ".foreman", "config.json")}`,
    ]);
  }

  const apps = entry.apps ?? [];
  return {
    ...mergeRepoSettings(config.repoDefaults, entry),
    alias,
    repoPath: expandHome(entry.path, home),
    team: entry.team,
    apps,
    appNames: apps.map((app) => app.name),
  };
}

/**
 * Resolves the instance's own entry by matching `cwd` against registry paths
 * (SPEC §3.11). Symlinks are resolved on both sides, and a cwd *inside* a
 * registered repo matches it, so running from a subdirectory works.
 *
 * The longest matching path wins, which is what makes a registered repo nested
 * inside another registered repo resolve to the inner one.
 */
export function entryForCwd(config: GlobalConfig, cwd: string, home?: string): ResolvedRepoEntry {
  const target = canonicalPath(cwd);

  let bestAlias: string | null = null;
  let bestLength = -1;
  for (const alias of Object.keys(config.repos)) {
    const candidate = canonicalPath(expandHome(config.repos[alias]!.path, home));
    const inside = target === candidate || target.startsWith(`${candidate}${sep}`);
    if (inside && candidate.length > bestLength) {
      bestAlias = alias;
      bestLength = candidate.length;
    }
  }

  if (bestAlias === null) {
    throw new ConfigError(`No repos entry matches the working directory ${target}`, [
      `add an entry under repos in ${join(home ?? homedir(), ".foreman", "config.json")}, or run foreman init`,
    ]);
  }
  return resolveRepoEntry(config, bestAlias, home);
}

/**
 * Inverts the registry into team key → alias: the reverse lookup a consumer
 * needs to find which repo owns a given Linear team, with no filesystem
 * scanning and no refresh interval.
 */
export function teamIndex(config: GlobalConfig): Record<string, string> {
  const index: Record<string, string> = {};
  for (const alias of Object.keys(config.repos)) {
    index[config.repos[alias]!.team] = alias;
  }
  return index;
}

/**
 * Resolves the Linear API key: the env var named by `config.linear.apiKeyEnv`
 * first, then the trimmed first line of `config.linear.apiKeyFile` (SPEC
 * §3.10) when the env var is unset.
 */
export function resolveLinearApiKey(
  config: GlobalConfig,
  env: Record<string, string | undefined> = process.env,
  home?: string,
): string {
  const fromEnv = env[config.linear.apiKeyEnv];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  if (config.linear.apiKeyFile !== null) {
    const path = expandHome(config.linear.apiKeyFile, home);
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      const firstLine = (contents.split("\n")[0] ?? "").trim();
      if (firstLine.length > 0) return firstLine;
    }
  }

  throw new ConfigError(
    `No Linear API key found. Set the ${config.linear.apiKeyEnv} environment variable, ` +
      `or point linear.apiKeyFile at a file whose first line is the key.`,
    [`env.${config.linear.apiKeyEnv} is unset`, `linear.apiKeyFile is ${config.linear.apiKeyFile ?? "unset"}`],
  );
}

/**
 * A dispatched agent's environment has every `LINEAR_*` name scrubbed
 * (`packages/loop/src/dispatch/{print,herdr}.ts`), so the child can only
 * resolve the credential from `linear.apiKeyFile`. An env-var-only
 * deployment cannot support loop dispatch (README "The shape of it").
 */
export function assertLoopDispatchCredential(config: GlobalConfig, home?: string): void {
  const file = config.linear.apiKeyFile;
  if (file === null || !existsSync(expandHome(file, home))) {
    throw new ConfigError("loop dispatch requires linear.apiKeyFile", [
      "every LINEAR_* env var is scrubbed from a dispatched agent's environment",
      "write the key to a file (`foreman setup` puts it at ~/.foreman/linear-api-key, mode 0600) and set linear.apiKeyFile",
    ]);
  }
}

/**
 * Every environment variable name a Linear credential could plausibly reach a
 * dispatched agent through: the configured one plus anything the operator's
 * shell exported under a `LINEAR_` prefix. Scrubbing only the configured name
 * leaves a second export of the same key readable by an agent holding `bash`.
 */
export function linearEnvNames(
  config: GlobalConfig,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const names = new Set<string>([config.linear.apiKeyEnv]);
  for (const name of Object.keys(env)) {
    if (/^LINEAR_/i.test(name)) names.add(name);
  }
  return [...names];
}

/** Lock TTL is `2 × maxRuntimeMs + lockTtlMarginMs` (SPEC §11). */
export function lockTtlMs(config: GlobalConfig): number {
  return 2 * config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs;
}

/**
 * Resolves configured GitHub App credentials (SPEC §7.4): `githubApp.appId`
 * and `githubApp.privateKeyFile` must be set together, or `null` is
 * returned — the unconfigured default, which leaves `foreman-review`
 * PR reviews Linear-comment-only exactly as before this existed. Setting
 * one without the other, or pointing at an unreadable key file, is a
 * mistake worth surfacing rather than silently ignoring.
 */
export function resolveGitHubAppCredentials(config: GlobalConfig, home?: string): GitHubAppCredentials | null {
  const { appId, privateKeyFile } = config.githubApp;
  if (appId === null && privateKeyFile === null) return null;
  if (appId === null || privateKeyFile === null) {
    throw new ConfigError("Incomplete githubApp config", [
      `githubApp.appId is ${appId ?? "unset"}`,
      `githubApp.privateKeyFile is ${privateKeyFile ?? "unset"}`,
      "both must be set together, or both left unset to disable App-authenticated reviews",
    ]);
  }
  const path = expandHome(privateKeyFile, home);
  if (!existsSync(path)) {
    throw new ConfigError(`GitHub App private key not found at ${path}`, [
      `githubApp.privateKeyFile is ${privateKeyFile}`,
    ]);
  }
  return { appId, privateKey: readFileSync(path, "utf8") };
}
