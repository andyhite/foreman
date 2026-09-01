/**
 * The omp plugin CLI surface Foreman drives: argv builders and the one
 * parser for its output (SPEC §3.1, §17.4).
 *
 * Kept separate from execution so `foreman init`'s command choices are
 * testable without a live omp install. The plugin is always installed
 * project-scoped, never user/machine-scoped: Foreman is per-repo by
 * construction — the `repos` registry binds specific repos to specific
 * Linear initiatives — so a plugin that fired in every session on the
 * machine would run its agents, skills, and TTSR rules against repos
 * Foreman was never registered against, which is the bug this module
 * exists to make unreachable. omp only honors `--scope` for a marketplace
 * install (`name@marketplace`); `omp plugin link` and local-path installs
 * are unconditionally user-wide regardless of the flag (verified against
 * omp 18.1.2 — SPEC §3.1, §17.4). So a marketplace install is the only way
 * in, and every repo Foreman manages runs the published plugin. Foreman's
 * own checkout is the sole exception, and it does not go through omp's CLI
 * at all: `plugin-link.ts` repoints the installed symlink afterwards.
 */

export const DEFAULT_GITHUB_REPO = "andyhite/foreman";
export const DEFAULT_OMP_PLUGIN_NAME = "foreman";
/** Marketplace id the catalog at `.omp-plugin/marketplace.json` declares. Fixed rather than derived from
 * the repo name, so a fork whose copied catalog still declares `foreman` still installs correctly. */
export const FOREMAN_MARKETPLACE_NAME = "foreman";

export function ompMarketplaceListArgv(): string[] {
  return ["plugin", "marketplace", "list"];
}

export function ompMarketplaceAddArgv(githubRepo: string): string[] {
  return ["plugin", "marketplace", "add", githubRepo];
}

export function ompPluginListArgv(): string[] {
  return ["plugin", "list"];
}

/** Always project scope — see the module comment for why user/machine scope is unreachable from here. */
export function ompInstallArgv(pluginName: string): string[] {
  return ["plugin", "install", `${pluginName}@${FOREMAN_MARKETPLACE_NAME}`, "--scope", "project"];
}

/** Removes a stray machine-wide install, e.g. one left over from before this project-scope cutover. */
export function ompUninstallUserArgv(pluginName: string): string[] {
  return ["plugin", "uninstall", "--scope", "user", `${pluginName}@${FOREMAN_MARKETPLACE_NAME}`];
}

/**
 * Pulls the marketplace's GitHub clone. Required before any upgrade: omp's
 * `upgrade` re-copies whatever the local clone already holds and never
 * fetches, so without this a "successful" upgrade reinstalls stale bits
 * (verified against omp 18.1.2).
 */
export function ompMarketplaceUpdateArgv(): string[] {
  return ["plugin", "marketplace", "update", FOREMAN_MARKETPLACE_NAME];
}

/**
 * Re-copies the refreshed clone into the version-keyed plugin cache and
 * repoints this repo's link at it. Must be run in *every* registered repo,
 * not just one: upgrading a repo to a new version deletes the superseded
 * cache directory, and any repo still linked to it is left dangling.
 */
export function ompUpgradeArgv(pluginName: string): string[] {
  return ["plugin", "upgrade", `${pluginName}@${FOREMAN_MARKETPLACE_NAME}`];
}

/** Scans `omp plugin list` output for a plugin@marketplace entry's scope(s). */
export function findPluginScopes(stdout: string, pluginName: string, marketplace: string): { project: boolean; user: boolean } {
  const needle = `${pluginName}@${marketplace}`;
  let project = false;
  let user = false;
  for (const line of stdout.split("\n")) {
    if (!line.includes(needle)) continue;
    if (line.includes("project")) project = true;
    if (line.includes("user")) user = true;
  }
  return { project, user };
}
