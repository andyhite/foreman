/**
 * Pure argv builders for the omp plugin CLI (SPEC §3.1, §17.4).
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
