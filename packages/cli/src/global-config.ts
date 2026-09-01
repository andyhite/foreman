/**
 * Builds and writes `~/.foreman/config.json` (SPEC §3.10).
 *
 * Written as a sparse patch over whatever's already on disk, not a full
 * `GlobalConfig` — `loadGlobalConfig` defaults every field it omits, and
 * writing every default back out would turn "unset, take the default" into
 * "pinned to today's default forever" the next time the schema's default
 * changes underneath an untouched config.
 */

import { defaultAndValidateGlobalConfig, type RepoEntry } from "@foreman/core";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A sparse slice of the global config. Both fields are optional because the two
 * writers own disjoint parts of the file: `foreman setup` writes the Linear
 * credential and never touches `repos`, `foreman init` writes exactly one
 * `repos` entry and never touches the credential.
 */
export interface ConfigPatch {
  repos?: Record<string, RepoEntry>;
  /** Registry aliases to remove in the same validated write as a repos patch. */
  removeRepos?: string[];
  linear?: {
    apiKeyFile?: string | null;
  };
}

function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Malformed config at ${configPath}: ${detail}. ` +
        "Fix the JSON syntax or move the file aside and re-run setup/init.",
      { cause: error },
    );
  }
}

export interface ExistingConfig {
  repos: Record<string, RepoEntry>;
  apiKeyFile: string | null;
}

/** Reads whatever is already on disk, defaulted for the wizard to show as prompt defaults. */
export function readGlobalConfig(home: string = homedir()): ExistingConfig {
  const configPath = join(home, ".foreman", "config.json");
  const existing = readExistingConfig(configPath);
  const linear = (existing.linear as Record<string, unknown> | undefined) ?? {};
  return {
    repos: (existing.repos as Record<string, RepoEntry> | undefined) ?? {},
    apiKeyFile: typeof linear.apiKeyFile === "string" ? linear.apiKeyFile : null,
  };
}

/** Deep-merges `patch` onto `existing` one object level deep, patch wins on conflicts. */
function mergePatch(existing: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
  const merged = { ...existing };

  if (patch.repos || patch.removeRepos) {
    const repos = { ...(existing.repos as Record<string, RepoEntry> | undefined), ...patch.repos };
    for (const alias of patch.removeRepos ?? []) delete repos[alias];
    if (Object.keys(repos).length > 0) merged.repos = repos;
    else delete merged.repos;
  }

  const existingLinear = (existing.linear as Record<string, unknown> | undefined) ?? {};
  const linearPatch: Record<string, unknown> = { ...existingLinear };
  if (patch.linear?.apiKeyFile) linearPatch.apiKeyFile = patch.linear.apiKeyFile;
  if (Object.keys(linearPatch).length > 0) merged.linear = linearPatch;

  return merged;
}

/**
 * Writes the merged config to `<home>/.foreman/config.json`, validating the
 * fully-defaulted result against `GlobalConfigSchema` first — a typo here
 * must fail before it reaches disk, not the next time `foreman-loop` starts.
 */
export function writeGlobalConfig(patch: ConfigPatch, home: string = homedir()): string {
  const dir = join(home, ".foreman");
  const configPath = join(dir, "config.json");
  const merged = mergePatch(readExistingConfig(configPath), patch);

  // Throws ConfigError before anything touches disk if the merged patch is invalid.
  defaultAndValidateGlobalConfig(structuredClone(merged), configPath);

  mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(merged, null, 2)}\n`;
  const tempPath = join(dir, `.config.json.tmp-${process.pid}`);
  writeFileSync(tempPath, payload, "utf8");
  renameSync(tempPath, configPath);
  return configPath;
}

/** Writes the Linear API key to `<home>/.foreman/linear-api-key`, mode 0600, and returns the path. */
export function writeLinearApiKeyFile(apiKey: string, home: string = homedir()): string {
  const dir = join(home, ".foreman");
  const keyPath = join(dir, "linear-api-key");
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${apiKey.trim()}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return keyPath;
}
