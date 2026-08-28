import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  type RepoConfigFile,
  RepoConfigFileSchema,
  type RepoSettings,
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

export type ResolvedRepoConfig = RepoSettings & { repoPath: string };

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

  const defaulted = Value.Default(GlobalConfigSchema, parsed);
  if (!Value.Check(GlobalConfigSchema, defaulted)) {
    const problems = formatValidationErrors(GlobalConfigSchema, defaulted);
    throw new ConfigError(`Invalid global config at ${path}`, problems);
  }

  const config = defaulted as GlobalConfig;
  if (Object.keys(config.projects).length === 0) {
    warnings.push("No projects mapped in config.projects; no Linear project resolves to a repo yet.");
  }

  return { config, sources, warnings };
}

/**
 * Deep-merges two settings objects key-by-key at the object-value level (not
 * whole-object replacement), so a repo overriding only `pr.draft` keeps the
 * default `pr.required` (SPEC §3.10).
 */
function mergeRepoSettings(base: RepoSettings, override: Partial<RepoSettings>): RepoSettings {
  return {
    baseBranch: override.baseBranch ?? base.baseBranch,
    pr: { ...base.pr, ...override.pr },
    merge: { ...base.merge, ...override.merge },
    branchPattern: override.branchPattern ?? base.branchPattern,
    worktreePattern: override.worktreePattern ?? base.worktreePattern,
  };
}

/**
 * Resolves the effective repo settings for `repoPath`: `config.repoDefaults`
 * deep-merged with `<repoPath>/.foreman/config.json` (repo wins) (SPEC §3.10).
 */
export function resolveRepoConfig(config: GlobalConfig, repoPath: string): ResolvedRepoConfig {
  const path = join(repoPath, ".foreman", "config.json");

  let override: RepoConfigFile = {};
  if (existsSync(path)) {
    const parsed = readJsonFile(path, "repo config");
    const defaulted = Value.Default(RepoConfigFileSchema, parsed);
    if (!Value.Check(RepoConfigFileSchema, defaulted)) {
      const problems = formatValidationErrors(RepoConfigFileSchema, defaulted);
      throw new ConfigError(`Invalid repo config at ${path}`, problems);
    }
    override = defaulted as RepoConfigFile;
  }

  const merged = mergeRepoSettings(config.repoDefaults, override);
  return { ...merged, repoPath };
}

/**
 * Resolves the Linear project id → repo path map (SPEC §3.5). Throws before
 * any spawn if the project is unmapped, and expands a leading `~` in the
 * mapped path.
 */
export function repoForProject(config: GlobalConfig, projectId: string, home?: string): string {
  const repoPath = config.projects[projectId];
  if (repoPath === undefined) {
    throw new ConfigError(
      `Linear project "${projectId}" is not mapped to a repo in config.projects`,
      [`projects.${projectId} is unset`],
    );
  }
  return expandHome(repoPath, home);
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
