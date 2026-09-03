/**
 * Activates Foreman's omp plugin for exactly the repos that opted in.
 *
 * ## Why this is hand-written rather than an `omp plugin` call
 *
 * The requirement is narrow: one global copy of the plugin, active only in
 * repos registered in `config.repos`. omp offers two install paths and
 * neither delivers that on its own.
 *
 *  - `omp plugin link <dir>` takes a local directory — exactly what a global
 *    install wants — but `--scope` is silently ignored for `link`: it always
 *    writes the *user* root, so the plugin's rules, skills, agents, and slash
 *    commands fire in every repo on the machine. Verified against omp 18.1.4:
 *    `omp plugin link <dir> --scope project` reports success, writes nothing
 *    to the project, and adds a user-scope entry.
 *  - `omp plugin install <name>@<marketplace> --scope project` does honor
 *    project scope, but only installs from a marketplace: a git clone of the
 *    catalog repo, copied into a cache directory keyed by the plugin version.
 *    That drags in a second distribution channel (network, clone, private-repo
 *    auth) that has to stay in sync with the checkout the CLI already runs
 *    from, forces the built bundle to be committed so the clone carries it, and
 *    — because the cache key is the version and the version never moves —
 *    serves whatever content it first cached forever. `omp plugin upgrade`
 *    compares versions and no-ops.
 *
 * ## What omp actually needs
 *
 * A project plugin root is just two things, and omp discovers a plugin from
 * them with no marketplace, cache, or network involved (verified against omp
 * 18.1.4 by probing a scratch repo over ACP):
 *
 *     <repo>/.omp/plugins/omp-plugins.lock.json
 *     <repo>/.omp/plugins/node_modules/@foreman/omp-plugin -> <plugin dir>
 *
 * That yields the whole surface — the extension module named by the package's
 * `omp.extensions`, plus the sibling `skills/`, `commands/`, `rules/`,
 * `agents/`, `hooks/`, `tools/`, and `prompts/` directories omp's capability
 * provider scans under an enabled plugin root. A `package.json` in the plugin
 * root is *not* required: discovery unions the dependency map with the lock's
 * own entries, so a lock-only entry is enough. Resolution walks up from the
 * process cwd, so it also works from a subdirectory.
 *
 * ## Why the repo link points at `~/.foreman/plugin`
 *
 * The per-repo symlink targets a single stable indirection written by
 * `foreman setup`, never the checkout directly. Re-cloning, relocating, or
 * pointing at a development checkout then updates one symlink and every
 * registered repo follows it — `foreman update` never has to touch a repo, and
 * there is no separate "dev mode" install shape to drift from the real one.
 * omp resolves symlink chains, so repo -> `~/.foreman/plugin` -> checkout
 * loads identically to a direct link.
 *
 * ## Why there is a second registry file
 *
 * The two files above make the extension module, `skills/`, `rules/`, and
 * `agents/` load, and make every `commands/*.md` file register under its
 * bare stem (`/refine`, not `/foreman:refine`) — omp's `omp-plugins`
 * provider never namespaces a command by plugin (verified against omp
 * 18.1.5: `packages/omp-plugin/src/discovery` — no, `omp`'s own
 * `discovery/omp-plugins.ts` `loadSlashCommands` uses the bare file stem
 * unconditionally). Only the `claude-plugins` provider prefixes a command
 * with its plugin id (`<plugin>:<file-stem>`), and it discovers plugins from
 * a different file: `<repo>/.omp/plugins/installed_plugins.json`, keyed by a
 * `<name>@<marketplace>` plugin id. `activateRepoPlugin` therefore also
 * upserts a `"foreman@foreman"` entry there, pointing at the same symlink,
 * so `DISPATCH_COMMAND` (`packages/core/src/domain/commands.ts`) resolves to
 * a real, `foreman:`-namespaced command instead of falling through as
 * unexpanded literal text that a dispatched session has to improvise around.
 * Both registries stay in sync because both point at the same
 * `node_modules/@foreman/omp-plugin` link: one plugin copy, discovered
 * twice, on two different keys.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The package name omp files the plugin under, from `packages/omp-plugin/package.json`. */
export const PLUGIN_PACKAGE_NAME = "@foreman/omp-plugin";

/** `<checkout>/packages/omp-plugin`. */
const CHECKOUT_PLUGIN_SEGMENTS = ["packages", "omp-plugin"] as const;

/** omp's project plugin root, relative to the repo root. */
const REPO_PLUGIN_ROOT_SEGMENTS = [".omp", "plugins"] as const;
const REPO_LINK_SEGMENTS = ["node_modules", "@foreman", "omp-plugin"] as const;
const LOCK_BASENAME = "omp-plugins.lock.json";
/** See the module docstring's "second registry file" section. */
const INSTALLED_PLUGINS_BASENAME = "installed_plugins.json";

/**
 * The plugin id `installed_plugins.json` files Foreman's entry under. Needs a
 * `<name>@<marketplace>` shape or omp's `claude-plugins` provider rejects it
 * outright (`Invalid plugin ID format (missing @marketplace)`); the part
 * before `@` becomes the slash-command namespace, so this is what makes
 * `commands/refine.md` resolve as `/foreman:refine` rather than `/refine`.
 */
const INSTALLED_PLUGIN_ID = "foreman@foreman";

/** The line `foreman init` adds to `.git/info/exclude`; the root is machine-local state. */
const GIT_EXCLUDE_LINE = "/.omp/plugins/";

/** omp's runtime state for one plugin, as omp writes it. */
interface LockEntry {
  version: string;
  /** `null` means "the plugin's default features", which is what Foreman wants. */
  enabledFeatures: string[] | null;
  enabled: boolean;
}

interface LockFile {
  plugins: Record<string, LockEntry>;
  settings: Record<string, unknown>;
}

/** One `installed_plugins.json` entry, in the shape omp's `claude-plugins` provider reads. */
interface InstalledPluginEntry {
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
  scope: "project";
}

/** omp's Claude-Code-compatible plugin registry format (`installed_plugins.json`). */
interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

// ---------------------------------------------------------------------------
// Global: the one plugin copy every repo links to
// ---------------------------------------------------------------------------

/** `<home>/.foreman/plugin` — the stable indirection every repo's symlink targets. */
export function globalPluginLinkPath(home: string = homedir()): string {
  return join(home, ".foreman", "plugin");
}

/** `<checkoutRoot>/packages/omp-plugin`. */
export function checkoutPluginDir(checkoutRoot: string): string {
  return join(checkoutRoot, ...CHECKOUT_PLUGIN_SEGMENTS);
}

export interface GlobalLinkResult {
  path: string;
  target: string;
  /** False when the link already pointed at `target` and nothing was rewritten. */
  changed: boolean;
}

/**
 * Points `<home>/.foreman/plugin` at `checkoutRoot`'s plugin package.
 *
 * Refuses to replace a real file or directory: only this function writes here,
 * so anything else is unrecognized state that deleting could destroy.
 */
export function writeGlobalPluginLink(checkoutRoot: string, home: string = homedir()): GlobalLinkResult {
  const path = globalPluginLinkPath(home);
  const target = checkoutPluginDir(checkoutRoot);

  if (!existsSync(target)) {
    throw new Error(`No plugin package at ${target} — ${checkoutRoot} does not look like a foreman checkout.`);
  }

  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(path) === target) return { path, target, changed: false };
    unlinkSync(path);
  } else if (existing) {
    throw new Error(
      `${path} is a real ${existing.isDirectory() ? "directory" : "file"}, not the symlink \`foreman setup\` writes. ` +
        "Remove it by hand if it is stale, then re-run `foreman setup`.",
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return { path, target, changed: true };
}

export interface GlobalLinkState {
  path: string;
  /** The raw symlink target, or null when the link is absent or not a symlink. */
  target: string | null;
  /** True when the link exists and resolves to an existing directory. */
  resolves: boolean;
  /** Version from the resolved package's `package.json`, when readable. */
  version: string | null;
}

/** Reads the current state of `<home>/.foreman/plugin` without changing anything. */
export function readGlobalPluginLink(home: string = homedir()): GlobalLinkState {
  const path = globalPluginLinkPath(home);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) {
    return { path, target: null, resolves: false, version: null };
  }
  const target = readlinkSync(path);
  const resolves = existsSync(path);
  return {
    path,
    target,
    resolves,
    version: resolves ? readPluginVersion(path) : null,
  };
}

/** The plugin package's declared version, or null when it cannot be read. */
function readPluginVersion(pluginDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-repo: the project plugin root
// ---------------------------------------------------------------------------

/** `<repoRoot>/.omp/plugins` — omp's project plugin root. */
export function repoPluginRoot(repoRoot: string): string {
  return join(repoRoot, ...REPO_PLUGIN_ROOT_SEGMENTS);
}

/** The symlink omp resolves the plugin through, inside `repoRoot`. */
export function repoPluginLinkPath(repoRoot: string): string {
  return join(repoPluginRoot(repoRoot), ...REPO_LINK_SEGMENTS);
}

/** `<repoRoot>/.omp/plugins/omp-plugins.lock.json`. */
export function repoPluginLockPath(repoRoot: string): string {
  return join(repoPluginRoot(repoRoot), LOCK_BASENAME);
}

/** `<repoRoot>/.omp/plugins/installed_plugins.json`. See the module docstring's "second registry file" section. */
export function repoInstalledPluginsPath(repoRoot: string): string {
  return join(repoPluginRoot(repoRoot), INSTALLED_PLUGINS_BASENAME);
}

/**
 * Reads `repoRoot`'s lock, preserving anything Foreman does not own.
 *
 * A lock that exists but does not parse is a hard error rather than a fresh
 * start: it may carry another plugin's enablement and settings, and silently
 * replacing it would disable that plugin with no way to tell what was lost.
 */
function readLock(lockPath: string): LockFile {
  if (!existsSync(lockPath)) return { plugins: {}, settings: {} };
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${lockPath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${lockPath} is not valid JSON, so Foreman will not overwrite it — it holds omp's enable state for every ` +
        "plugin in this repo. Fix or delete the file, then re-run.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${lockPath} is not a JSON object, so Foreman will not overwrite it. Fix or delete the file.`);
  }
  const record = parsed as { plugins?: unknown; settings?: unknown };
  const plugins =
    typeof record.plugins === "object" && record.plugins !== null && !Array.isArray(record.plugins)
      ? (record.plugins as Record<string, LockEntry>)
      : {};
  const settings =
    typeof record.settings === "object" && record.settings !== null && !Array.isArray(record.settings)
      ? (record.settings as Record<string, unknown>)
      : {};
  return { plugins, settings };
}

/** Atomic write, so a crash mid-write cannot leave omp a truncated lock. */
function writeLock(lockPath: string, lock: LockFile): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const tmp = `${lockPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  renameSync(tmp, lockPath);
}

/**
 * Reads `repoRoot`'s `installed_plugins.json`, preserving anything Foreman
 * does not own. Mirrors `readLock`'s fail-loud-on-garbage behavior for the
 * same reason: this file may carry another tool's plugin registrations.
 */
function readInstalledPlugins(path: string): InstalledPluginsFile {
  if (!existsSync(path)) return { version: 1, plugins: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not valid JSON, so Foreman will not overwrite it — it may hold another tool's plugin ` +
        "registrations. Fix or delete the file, then re-run.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object, so Foreman will not overwrite it. Fix or delete the file.`);
  }
  const record = parsed as { version?: unknown; plugins?: unknown };
  const version = typeof record.version === "number" ? record.version : 1;
  const plugins =
    typeof record.plugins === "object" && record.plugins !== null && !Array.isArray(record.plugins)
      ? (record.plugins as Record<string, InstalledPluginEntry[]>)
      : {};
  return { version, plugins };
}

/** Atomic write, matching `writeLock`. */
function writeInstalledPlugins(path: string, file: InstalledPluginsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export interface ActivationResult {
  linkPath: string;
  /** Absolute path the repo's symlink now points at (the global indirection). */
  target: string;
  linkChanged: boolean;
  lockPath: string;
  lockChanged: boolean;
  /** Version recorded in the lock, read from the linked plugin package. */
  version: string;
  installedPluginsPath: string;
  /** True when the `installed_plugins.json` entry that namespaces slash commands under `foreman:` was written. */
  installedPluginsChanged: boolean;
}

/**
 * Makes Foreman's plugin active in `repoRoot`, and nowhere else.
 *
 * Idempotent: re-running rewrites nothing when the link and lock entry already
 * match. Requires `foreman setup` to have written the global link first — a
 * repo link pointing at a target that does not exist would leave omp silently
 * loading nothing, which is the failure mode this whole module exists to end.
 */
export function activateRepoPlugin(repoRoot: string, home: string = homedir()): ActivationResult {
  const target = globalPluginLinkPath(home);
  if (!existsSync(target)) {
    throw new Error(
      `${target} does not exist, so this repo has no plugin to link to. Run \`foreman setup\` first — it writes ` +
        "that link and points it at your foreman checkout.",
    );
  }

  const linkPath = repoPluginLinkPath(repoRoot);
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  let linkChanged = true;
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === target) {
      linkChanged = false;
    } else {
      unlinkSync(linkPath);
    }
  } else if (existing) {
    throw new Error(
      `${linkPath} is a real ${existing.isDirectory() ? "directory" : "file"}, not a symlink. Foreman will not ` +
        "delete it. Remove it by hand if it is stale, then re-run `foreman init`.",
    );
  }
  if (linkChanged) {
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath);
  }

  // Read the version through the link so the lock records what is actually
  // linked, not what some other copy of the plugin happens to declare.
  const version = readPluginVersion(linkPath) ?? "0.0.0";

  const lockPath = repoPluginLockPath(repoRoot);
  const lock = readLock(lockPath);
  const current = lock.plugins[PLUGIN_PACKAGE_NAME];
  const desired: LockEntry = { version, enabledFeatures: null, enabled: true };
  const lockChanged =
    current === undefined ||
    current.version !== desired.version ||
    current.enabled !== desired.enabled ||
    current.enabledFeatures !== null;
  if (lockChanged) {
    lock.plugins[PLUGIN_PACKAGE_NAME] = desired;
    writeLock(lockPath, lock);
  }

  const installedPluginsPath = repoInstalledPluginsPath(repoRoot);
  const installedPlugins = readInstalledPlugins(installedPluginsPath);
  const existingEntries = installedPlugins.plugins[INSTALLED_PLUGIN_ID];
  const existingEntry = existingEntries?.[0];
  const now = new Date().toISOString();
  const desiredEntry: InstalledPluginEntry = {
    installPath: linkPath,
    version,
    installedAt: existingEntry?.installedAt ?? now,
    lastUpdated: now,
    enabled: true,
    scope: "project",
  };
  const installedPluginsChanged =
    existingEntries === undefined ||
    existingEntries.length !== 1 ||
    existingEntry?.installPath !== desiredEntry.installPath ||
    existingEntry?.version !== desiredEntry.version ||
    existingEntry?.enabled !== desiredEntry.enabled ||
    existingEntry?.scope !== desiredEntry.scope;
  if (installedPluginsChanged) {
    installedPlugins.plugins[INSTALLED_PLUGIN_ID] = [desiredEntry];
    writeInstalledPlugins(installedPluginsPath, installedPlugins);
  }

  return { linkPath, target, linkChanged, lockPath, lockChanged, version, installedPluginsPath, installedPluginsChanged };
}

export interface DeactivationResult {
  linkPath: string;
  /** True when a symlink was removed. */
  linkRemoved: boolean;
  lockPath: string;
  /** True when Foreman's entry was removed from an existing lock. */
  lockEntryRemoved: boolean;
  /** True when the lock held nothing else and was deleted outright. */
  lockRemoved: boolean;
  installedPluginsPath: string;
  /** True when Foreman's `foreman@foreman` entry was removed from an existing `installed_plugins.json`. */
  installedPluginsEntryRemoved: boolean;
  /** True when `installed_plugins.json` held nothing else and was deleted outright. */
  installedPluginsRemoved: boolean;
  /** Directories pruned because removing the link left them empty. */
  prunedDirs: string[];
}

/**
 * Undoes `activateRepoPlugin`, leaving no trace in a repo that no longer uses
 * Foreman. Anything Foreman did not create is left alone: another plugin's
 * lock entries, its settings, and a `.omp/` that still holds project config.
 */
export function deactivateRepoPlugin(repoRoot: string): DeactivationResult {
  const linkPath = repoPluginLinkPath(repoRoot);
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  let linkRemoved = false;
  if (existing?.isSymbolicLink()) {
    unlinkSync(linkPath);
    linkRemoved = true;
  }

  const lockPath = repoPluginLockPath(repoRoot);
  let lockEntryRemoved = false;
  let lockRemoved = false;
  if (existsSync(lockPath)) {
    const lock = readLock(lockPath);
    if (lock.plugins[PLUGIN_PACKAGE_NAME] !== undefined) {
      delete lock.plugins[PLUGIN_PACKAGE_NAME];
      lockEntryRemoved = true;
    }
    const empty = Object.keys(lock.plugins).length === 0 && Object.keys(lock.settings).length === 0;
    if (empty) {
      unlinkSync(lockPath);
      lockRemoved = true;
    } else if (lockEntryRemoved) {
      writeLock(lockPath, lock);
    }
  }

  const installedPluginsPath = repoInstalledPluginsPath(repoRoot);
  let installedPluginsEntryRemoved = false;
  let installedPluginsRemoved = false;
  if (existsSync(installedPluginsPath)) {
    const installedPlugins = readInstalledPlugins(installedPluginsPath);
    if (installedPlugins.plugins[INSTALLED_PLUGIN_ID] !== undefined) {
      delete installedPlugins.plugins[INSTALLED_PLUGIN_ID];
      installedPluginsEntryRemoved = true;
    }
    const empty = Object.keys(installedPlugins.plugins).length === 0;
    if (empty) {
      unlinkSync(installedPluginsPath);
      installedPluginsRemoved = true;
    } else if (installedPluginsEntryRemoved) {
      writeInstalledPlugins(installedPluginsPath, installedPlugins);
    }
  }

  // Prune innermost first, and only while empty, so a repo that keeps other
  // omp project config (`.omp/config.yml`, `.omp/skills/`) keeps it.
  const prunedDirs: string[] = [];
  for (const dir of [
    dirname(linkPath), // .omp/plugins/node_modules/@foreman
    dirname(dirname(linkPath)), // .omp/plugins/node_modules
    repoPluginRoot(repoRoot), // .omp/plugins
    join(repoRoot, ".omp"),
  ]) {
    try {
      rmdirSync(dir);
      prunedDirs.push(dir);
    } catch {
      break;
    }
  }

  return {
    linkPath,
    linkRemoved,
    lockPath,
    lockEntryRemoved,
    lockRemoved,
    installedPluginsPath,
    installedPluginsEntryRemoved,
    installedPluginsRemoved,
    prunedDirs,
  };
}

export interface ActivationState {
  linkPath: string;
  lockPath: string;
  /** The symlink's raw target, or null when absent/not a symlink. */
  linkTarget: string | null;
  /** What the link should point at for this `home`. */
  expectedTarget: string;
  /** True when the link exists, points at `expectedTarget`, and resolves. */
  linkHealthy: boolean;
  lockEntryPresent: boolean;
  lockEntryEnabled: boolean;
  installedPluginsPath: string;
  /** True when `installed_plugins.json` has a `foreman@foreman` entry. */
  installedPluginsEntryPresent: boolean;
  /** True when that entry is enabled — needed for `foreman:`-namespaced commands to expand. */
  installedPluginsEntryEnabled: boolean;
  /** True when omp will load the full plugin in this repo. */
  active: boolean;
  /** Operator-facing description of every reason `active` is false. */
  problems: string[];
}

/**
 * Reports whether omp will load Foreman in `repoRoot`, and why not if it will
 * not. Read-only: this is what `foreman doctor` reports and what `--fix`
 * decides from.
 *
 * `omp plugin list` is deliberately not consulted. It reads the user plugin
 * root and marketplace registries, so it reports nothing at all for a
 * project-scope link (verified against omp 18.1.4) — probing it is how the
 * previous implementation concluded a healthy repo was uninstalled.
 */
export function inspectRepoActivation(repoRoot: string, home: string = homedir()): ActivationState {
  const linkPath = repoPluginLinkPath(repoRoot);
  const lockPath = repoPluginLockPath(repoRoot);
  const expectedTarget = globalPluginLinkPath(home);
  const problems: string[] = [];

  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  let linkTarget: string | null = null;
  let linkHealthy = false;
  if (!stat) {
    problems.push(`${linkPath} is missing — the plugin is not linked into this repo.`);
  } else if (!stat.isSymbolicLink()) {
    problems.push(`${linkPath} is a real ${stat.isDirectory() ? "directory" : "file"}, not the expected symlink.`);
  } else {
    linkTarget = readlinkSync(linkPath);
    if (linkTarget !== expectedTarget) {
      problems.push(`${linkPath} points at ${linkTarget}, not ${expectedTarget}.`);
    } else if (!existsSync(linkPath)) {
      problems.push(`${linkPath} points at ${expectedTarget}, which does not resolve — run \`foreman setup\`.`);
    } else {
      linkHealthy = true;
    }
  }

  let lockEntryPresent = false;
  let lockEntryEnabled = false;
  try {
    const lock = readLock(lockPath);
    const entry = lock.plugins[PLUGIN_PACKAGE_NAME];
    lockEntryPresent = entry !== undefined;
    lockEntryEnabled = entry?.enabled === true;
    if (!lockEntryPresent) {
      problems.push(`${lockPath} has no "${PLUGIN_PACKAGE_NAME}" entry, so omp will not load it.`);
    } else if (!lockEntryEnabled) {
      problems.push(`"${PLUGIN_PACKAGE_NAME}" is disabled in ${lockPath}.`);
    }
  } catch (error) {
    problems.push((error as Error).message);
  }

  const installedPluginsPath = repoInstalledPluginsPath(repoRoot);
  let installedPluginsEntryPresent = false;
  let installedPluginsEntryEnabled = false;
  try {
    const installedPlugins = readInstalledPlugins(installedPluginsPath);
    const entry = installedPlugins.plugins[INSTALLED_PLUGIN_ID]?.[0];
    installedPluginsEntryPresent = entry !== undefined;
    installedPluginsEntryEnabled = entry?.enabled === true;
    if (!installedPluginsEntryPresent) {
      problems.push(
        `${installedPluginsPath} has no "${INSTALLED_PLUGIN_ID}" entry, so \`foreman:\`-namespaced commands ` +
          "(e.g. /foreman:refine) will not expand.",
      );
    } else if (!installedPluginsEntryEnabled) {
      problems.push(`"${INSTALLED_PLUGIN_ID}" is disabled in ${installedPluginsPath}.`);
    }
  } catch (error) {
    problems.push((error as Error).message);
  }

  return {
    linkPath,
    lockPath,
    linkTarget,
    expectedTarget,
    linkHealthy,
    lockEntryPresent,
    lockEntryEnabled,
    installedPluginsPath,
    installedPluginsEntryPresent,
    installedPluginsEntryEnabled,
    active: linkHealthy && lockEntryEnabled && installedPluginsEntryEnabled,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Keeping a managed repo's `git status` clean
// ---------------------------------------------------------------------------

/**
 * Resolves a repo's git directory, following the `gitdir:` pointer a linked
 * worktree uses in place of a `.git` directory.
 */
function resolveGitDir(repoRoot: string): string | null {
  const dotGit = join(repoRoot, ".git");
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) return dotGit;
  try {
    const pointer = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match?.[1]) return null;
    const dir = match[1];
    return dir.startsWith("/") ? dir : join(repoRoot, dir);
  } catch {
    return null;
  }
}

export interface GitExcludeResult {
  path: string;
  /** False when the line was already present. */
  changed: boolean;
}

/**
 * Ignores `.omp/plugins/` via `.git/info/exclude` rather than the repo's
 * tracked `.gitignore`.
 *
 * The plugin root is machine-local state — a symlink into this user's home and
 * this machine's enable lock — so it must never be committed, and Foreman has
 * no business editing a tracked file in a repo it only manages. `info/exclude`
 * is the per-clone equivalent and is exactly what it is for.
 *
 * Returns null when there is no git directory to write into.
 */
export function ensureGitExclude(repoRoot: string): GitExcludeResult | null {
  const gitDir = resolveGitDir(repoRoot);
  if (gitDir === null) return null;

  const path = join(gitDir, "info", "exclude");
  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`Could not read ${path}: ${String(error)}`);
    }
    if (existing.split("\n").some((line) => line.trim() === GIT_EXCLUDE_LINE)) {
      return { path, changed: false };
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${existing}${prefix}# Foreman's omp plugin root: a symlink into ~/.foreman plus this machine's enable lock.\n${GIT_EXCLUDE_LINE}\n`,
    "utf8",
  );
  return { path, changed: true };
}

// ---------------------------------------------------------------------------
// Detecting the machine-wide install this design exists to prevent
// ---------------------------------------------------------------------------

export interface UserScopeInstall {
  /** omp's user plugin root that carries the install. */
  root: string;
  /** True when `omp-plugins.lock.json` there has a Foreman entry. */
  lockEntry: boolean;
  /** True when a `node_modules/@foreman/omp-plugin` symlink is still present. */
  danglingLink: boolean;
  /** The symlink path, whether or not it is present. */
  linkPath: string;
  lockPath: string;
}

/**
 * omp's user plugin roots, newest convention first. XDG only applies once
 * `omp config init-xdg` has created the roots and the variables are exported,
 * so both locations are checked rather than guessed between.
 */
function userPluginRoots(home: string): string[] {
  const roots: string[] = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) roots.push(join(xdg, "omp", "plugins"));
  roots.push(join(home, ".omp", "plugins"));
  return roots;
}

/**
 * Finds a machine-wide install of Foreman's plugin — the thing that makes its
 * rules, skills, and agents fire in unrelated repos.
 *
 * Worth reporting on every run, not just once: a stray `omp plugin link` from
 * a shell (or an older Foreman release) reintroduces it silently, and the
 * symptom is a subtly worse agent in every other project. `omp plugin
 * uninstall` also leaves the `node_modules` symlink behind (verified against
 * omp 18.1.4), so a dangling link is reported independently of the lock entry.
 */
export function findUserScopeInstall(home: string = homedir()): UserScopeInstall | null {
  for (const root of userPluginRoots(home)) {
    const lockPath = join(root, LOCK_BASENAME);
    const linkPath = join(root, ...REPO_LINK_SEGMENTS);

    let lockEntry = false;
    if (existsSync(lockPath)) {
      try {
        const lock = readLock(lockPath);
        lockEntry = lock.plugins[PLUGIN_PACKAGE_NAME] !== undefined;
      } catch {
        // An unreadable user lock is omp's problem to report, not a reason to
        // claim Foreman is installed machine-wide.
        lockEntry = false;
      }
    }
    const danglingLink = lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink() === true;

    if (lockEntry || danglingLink) return { root, lockEntry, danglingLink, linkPath, lockPath };
  }
  return null;
}

/**
 * Removes a machine-wide install: drops the lock entry and deletes the
 * leftover symlink omp's own uninstall leaves behind.
 *
 * Done directly rather than by shelling out to `omp plugin uninstall` because
 * that command only half-removes it, and because this has to work when `omp`
 * is not on PATH.
 */
export function removeUserScopeInstall(install: UserScopeInstall): { lockChanged: boolean; linkRemoved: boolean } {
  let lockChanged = false;
  if (install.lockEntry) {
    const lock = readLock(install.lockPath);
    if (lock.plugins[PLUGIN_PACKAGE_NAME] !== undefined) {
      delete lock.plugins[PLUGIN_PACKAGE_NAME];
      writeLock(install.lockPath, lock);
      lockChanged = true;
    }
  }
  let linkRemoved = false;
  if (lstatSync(install.linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    unlinkSync(install.linkPath);
    linkRemoved = true;
    // The `@foreman` scope directory is Foreman's alone; prune it when empty.
    try {
      rmdirSync(dirname(install.linkPath));
    } catch {
      // Not empty, or not ours to remove.
    }
  }
  return { lockChanged, linkRemoved };
}
