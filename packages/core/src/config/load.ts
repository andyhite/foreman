import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
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
  /** Registry key: the `--repo` argument, herdr workspace name, and state-dir segment. */
  alias: string;
  /** Absolute, `~`-expanded. */
  repoPath: string;
  /** `null` when the entry defers team resolution to `--team` or the sole accessible team. */
  team: string | null;
  initiativeIds: string[];
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
 * Rejects an initiative bound in two registry entries (SPEC §3.10). The split
 * per-repo files could not catch this — no single instance could see the
 * collision — so it is checked once, here, at load.
 */
function assertInitiativesUnique(config: GlobalConfig, describeFor: string): void {
  const ownerByInitiative: Record<string, string> = {};
  const problems: string[] = [];
  for (const alias of Object.keys(config.repos)) {
    for (const id of boundInitiativeIds(config.repos[alias]!)) {
      const owner = ownerByInitiative[id];
      if (owner !== undefined) {
        problems.push(`initiative ${id} is bound to both repos.${owner} and repos.${alias}`);
        continue;
      }
      ownerByInitiative[id] = alias;
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
  const defaulted = Value.Default(GlobalConfigSchema, value);
  if (!Value.Check(GlobalConfigSchema, defaulted)) {
    const problems = formatValidationErrors(GlobalConfigSchema, defaulted);
    throw new ConfigError(`Invalid global config${describeFor ? ` at ${describeFor}` : ""}`, problems);
  }
  return defaulted as GlobalConfig;
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
  assertInitiativesUnique(config, path);
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
 * Every initiative ID bound to `entry`, discarding the optional path hints.
 * Exported because it is the instance's scope set (SPEC §3.11) and intake's
 * index key (SPEC §3.12), and both must read bindings the same way.
 */
export function boundInitiativeIds(entry: RepoEntry): string[] {
  return entry.initiatives.map((binding) => (typeof binding === "string" ? binding : binding.id));
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

  return {
    ...mergeRepoSettings(config.repoDefaults, entry),
    alias,
    repoPath: expandHome(entry.path, home),
    team: entry.team ?? null,
    initiativeIds: boundInitiativeIds(entry),
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
      `add an entry under repos in ${join(home ?? homedir(), ".foreman", "config.json")}, or pass --repo <alias>`,
    ]);
  }
  return resolveRepoEntry(config, bestAlias, home);
}

/**
 * Inverts the registry into initiative ID → alias (SPEC §3.12). Intake is
 * team-level and needs repos for repro and context reads; this is the whole of
 * that lookup — no filesystem scanning, no refresh interval.
 */
export function initiativeIndex(config: GlobalConfig): Record<string, string> {
  const index: Record<string, string> = {};
  for (const alias of Object.keys(config.repos)) {
    for (const id of boundInitiativeIds(config.repos[alias]!)) {
      index[id] = alias;
    }
  }
  return index;
}

/**
 * Resolves the Linear API key: the env var named by `config.linear.apiKeyEnv`
 * first, then the trimmed first line of `config.linear.apiKeyFile` (SPEC
 * §3.10, §17.4 — the herdr-hosted board reads from the file when the env var
 * is unset).
 */
export function resolveLinearApiKey(config: GlobalConfig, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[config.linear.apiKeyEnv];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  if (config.linear.apiKeyFile !== null) {
    const path = expandHome(config.linear.apiKeyFile);
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

/** Lock TTL is `2 × maxRuntimeMs + lockTtlMarginMs` (SPEC §11). */
export function lockTtlMs(config: GlobalConfig): number {
  return 2 * config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs;
}
