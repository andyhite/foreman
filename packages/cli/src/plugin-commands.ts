/**
 * Pure argv builders for the omp plugin CLI (SPEC §3.1, §17.4).
 *
 * Kept separate from execution so the wizard's command choices are testable
 * without a live omp install. Two install strategies:
 *
 * - `link` ("dev mode"): symlinks this checkout's plugin directory in place.
 *   omp doesn't run the plugin's own build step for a linked path (verified
 *   against omp — SPEC §3.1, §17.4), so the caller must build first.
 * - `install`: registers the plugin from GitHub, no local checkout required
 *   afterward. omp builds the fetched checkout itself.
 */

export const DEFAULT_GITHUB_REPO = "andyhite/foreman";
export const DEFAULT_OMP_PLUGIN_NAME = "foreman";
/** Marketplace id the catalog at `.omp-plugin/marketplace.json` declares. Fixed rather than derived from
 * the repo name, so a fork whose copied catalog still declares `foreman` still installs correctly. */
export const FOREMAN_MARKETPLACE_NAME = "foreman";
export type OmpScope = "user" | "project";

export function ompLinkArgv(pluginDir: string, scope: OmpScope): string[] {
  return ["plugin", "link", pluginDir, "--scope", scope];
}

export function ompMarketplaceAddArgv(githubRepo: string): string[] {
  return ["plugin", "marketplace", "add", githubRepo];
}

export function ompInstallArgv(pluginName: string, scope: OmpScope): string[] {
  return ["plugin", "install", `${pluginName}@${FOREMAN_MARKETPLACE_NAME}`, "--scope", scope];
}

