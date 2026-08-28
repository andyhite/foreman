/**
 * Pure argv builders for the omp/herdr plugin CLIs (SPEC §3.1, §17.4).
 *
 * Kept separate from execution so the wizard's command choices are testable
 * without a live omp/herdr install. Two install strategies per host:
 *
 * - `link` ("dev mode"): symlinks this checkout's plugin directory in place.
 *   Neither CLI runs the plugin's own build step for a linked path (verified
 *   against omp and herdr — SPEC §3.1, §17.4), so the caller must build first.
 * - `install`: registers the plugin from GitHub, no local checkout required
 *   afterward. Both CLIs build the fetched checkout themselves.
 */

export const DEFAULT_GITHUB_REPO = "andyhite/foreman";
export const DEFAULT_OMP_PLUGIN_NAME = "foreman";
export type OmpScope = "user" | "project";

/** Marketplace id omp assigns a GitHub-sourced marketplace: the repo's own name. */
export function marketplaceNameFor(githubRepo: string): string {
  return githubRepo.split("/").at(-1) ?? githubRepo;
}

export function ompLinkArgv(pluginDir: string, scope: OmpScope): string[] {
  return ["plugin", "link", pluginDir, "--scope", scope];
}

export function ompMarketplaceAddArgv(githubRepo: string): string[] {
  return ["plugin", "marketplace", "add", githubRepo];
}

export function ompInstallArgv(pluginName: string, githubRepo: string, scope: OmpScope): string[] {
  return ["plugin", "install", `${pluginName}@${marketplaceNameFor(githubRepo)}`, "--scope", scope];
}

export function herdrLinkArgv(pluginDir: string): string[] {
  return ["plugin", "link", pluginDir];
}

export function herdrInstallArgv(githubRepo: string, subdir: string): string[] {
  return ["plugin", "install", `${githubRepo}/${subdir}`];
}
