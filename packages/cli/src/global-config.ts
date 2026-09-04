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
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { withFileLock } from "./file-lock.ts";

/**
 * Opens `path` for exclusive-write with `O_NOFOLLOW`, so a symlink planted
 * at that path — before this call or in the TOCTOU window after an earlier
 * `lstatSync` check — is refused atomically by the kernel rather than
 * followed. `create`/`truncate`/`excl` select O_CREAT/O_TRUNC/O_EXCL.
 */
function openNoFollow(path: string, mode: number, options: { excl?: boolean } = {}): number {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_NOFOLLOW |
    (options.excl ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
  return openSync(path, flags, mode);
}

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
    /** The operator's own Linear user id — resolved from their email by `foreman setup` (SPEC: assignee-based ownership). `null` clears it. */
    operatorUserId?: string | null;
  };
  /** The GitHub App `foreman-review` submits real PR reviews under (SPEC §7.4). Both fields set together, or both `null` to disable. */
  githubApp?: {
    appId?: string | null;
    privateKeyFile?: string | null;
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
  /** The env var checked first for the Linear key, defaulted like every other schema field via `defaultAndValidateGlobalConfig`. */
  apiKeyEnv: string;
  /** Already-configured operator account, shown back as the wizard's re-run default. */
  operatorUserId: string | null;
  /** Already-configured GitHub App id, shown back as the wizard's re-run default (SPEC §7.4). */
  githubAppId: string | null;
  /**
   * `repoDefaults.baseBranch` as it would be seen after schema defaulting —
   * the value a `repos` entry actually inherits when it omits its own
   * `baseBranch` override. Derived through `defaultAndValidateGlobalConfig`
   * rather than hand-rolled so this never drifts from the schema default.
   *
   * Validated in isolation from `repos`: a config that's merely incomplete
   * (or has `repos` entries this reader isn't ready to fully validate) must
   * still produce a usable default here, since callers use this to show
   * wizard prompt defaults and to decide what to sparsely write, not to
   * assert the whole file is valid.
   */
  effectiveBaseBranch: string;
}

/** Reads whatever is already on disk, defaulted for the wizard to show as prompt defaults. */
export function readGlobalConfig(home: string = homedir()): ExistingConfig {
  const configPath = join(home, ".foreman", "config.json");
  const existing = readExistingConfig(configPath);
  const linear = (existing.linear as Record<string, unknown> | undefined) ?? {};
  const githubApp = (existing.githubApp as Record<string, unknown> | undefined) ?? {};
  const defaulted = defaultAndValidateGlobalConfig({ repoDefaults: existing.repoDefaults ?? {} }, configPath);
  return {
    repos: (existing.repos as Record<string, RepoEntry> | undefined) ?? {},
    apiKeyFile: typeof linear.apiKeyFile === "string" ? linear.apiKeyFile : null,
    apiKeyEnv: typeof linear.apiKeyEnv === "string" ? linear.apiKeyEnv : "LINEAR_API_KEY",
    operatorUserId: typeof linear.operatorUserId === "string" ? linear.operatorUserId : null,
    githubAppId: typeof githubApp.appId === "string" ? githubApp.appId : null,
    effectiveBaseBranch: defaulted.repoDefaults.baseBranch,
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
  if (patch.linear && "operatorUserId" in patch.linear) linearPatch.operatorUserId = patch.linear.operatorUserId;
  if (Object.keys(linearPatch).length > 0) merged.linear = linearPatch;

  const existingGithubApp = (existing.githubApp as Record<string, unknown> | undefined) ?? {};
  const githubAppPatch: Record<string, unknown> = { ...existingGithubApp };
  if (patch.githubApp && "appId" in patch.githubApp) githubAppPatch.appId = patch.githubApp.appId;
  if (patch.githubApp && "privateKeyFile" in patch.githubApp) githubAppPatch.privateKeyFile = patch.githubApp.privateKeyFile;
  if (Object.keys(githubAppPatch).length > 0) merged.githubApp = githubAppPatch;

  return merged;
}


/**
 * Writes the merged config to `<home>/.foreman/config.json`, validating the
 * fully-defaulted result against `GlobalConfigSchema` first — a typo here
 * must fail before it reaches disk, not the next time a loop process starts.
 */
export function writeGlobalConfig(patch: ConfigPatch, home: string = homedir()): string {
  const dir = join(home, ".foreman");
  const configPath = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  return withFileLock(join(dir, ".config.json.lock"), () => {
    const merged = mergePatch(readExistingConfig(configPath), patch);

    // Throws ConfigError before anything touches disk if the merged patch is invalid.
    defaultAndValidateGlobalConfig(structuredClone(merged), configPath);

    const payload = `${JSON.stringify(merged, null, 2)}\n`;
    // A random suffix (not just the pid) plus O_EXCL|O_NOFOLLOW rules out
    // both a same-pid reuse collision and a pre-planted symlink at the temp
    // path redirecting this write.
    const tempPath = join(dir, `.config.json.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fd = openNoFollow(tempPath, 0o600, { excl: true });
    try {
      writeSync(fd, payload, null, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, configPath);
    chmodSync(configPath, 0o600);
    return configPath;
  });
}

/** Writes the Linear API key to `<home>/.foreman/linear-api-key`, mode 0600, and returns the path. */
export function writeLinearApiKeyFile(apiKey: string, home: string = homedir()): string {
  const dir = join(home, ".foreman");
  const keyPath = join(dir, "linear-api-key");
  mkdirSync(dirname(keyPath), { recursive: true });
  // A pre-planted symlink here would redirect both the write and the chmod
  // to whatever it points at. `lstatSync` gives a clear, friendly error for
  // the common case; `openNoFollow`'s O_NOFOLLOW is what actually closes
  // the TOCTOU window between this check and the write below.
  let existing;
  try {
    existing = lstatSync(keyPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`${keyPath} is a symlink; refusing to write the Linear API key through it. Remove it and re-run.`);
  }
  const fd = openNoFollow(keyPath, 0o600);
  try {
    writeSync(fd, `${apiKey.trim()}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(keyPath, 0o600);
  return keyPath;
}

/** Writes the GitHub App's PEM private key to `<home>/.foreman/github-app-private-key.pem`, mode 0600, and returns the path (SPEC §7.4). */
export function writeGitHubAppPrivateKeyFile(privateKey: string, home: string = homedir()): string {
  const dir = join(home, ".foreman");
  const keyPath = join(dir, "github-app-private-key.pem");
  mkdirSync(dirname(keyPath), { recursive: true });
  // A pre-planted symlink here would redirect both the write and the chmod
  // to whatever it points at. `lstatSync` gives a clear, friendly error for
  // the common case; `openNoFollow`'s O_NOFOLLOW is what actually closes
  // the TOCTOU window between this check and the write below.
  let existing;
  try {
    existing = lstatSync(keyPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`${keyPath} is a symlink; refusing to write the GitHub App private key through it. Remove it and re-run.`);
  }
  const trimmed = privateKey.trim();
  const fd = openNoFollow(keyPath, 0o600);
  try {
    writeSync(fd, trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`, null, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(keyPath, 0o600);
  return keyPath;
}
