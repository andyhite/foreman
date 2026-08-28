/**
 * Builds and writes `~/.foreman/config.json` (SPEC §3.10).
 *
 * Written as a sparse patch over whatever's already on disk, not a full
 * `GlobalConfig` — `loadGlobalConfig` defaults every field it omits, and
 * writing every default back out would turn "unset, take the default" into
 * "pinned to today's default forever" the next time the schema's default
 * changes underneath an untouched config.
 */

import { defaultAndValidateGlobalConfig } from "@foreman/core";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ConfigPatch {
  projects: Record<string, string>;
  linear: {
    teamKeys: string[];
    apiKeyFile: string | null;
  };
}

function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  return raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Deep-merges `patch` onto `existing` one object level deep, patch wins on conflicts. */
function mergePatch(existing: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
  const merged = { ...existing };

  if (Object.keys(patch.projects).length > 0) {
    merged.projects = { ...(existing.projects as Record<string, string> | undefined), ...patch.projects };
  }

  const existingLinear = (existing.linear as Record<string, unknown> | undefined) ?? {};
  const linearPatch: Record<string, unknown> = { ...existingLinear };
  if (patch.linear.teamKeys.length > 0) linearPatch.teamKeys = patch.linear.teamKeys;
  if (patch.linear.apiKeyFile) linearPatch.apiKeyFile = patch.linear.apiKeyFile;
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
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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
