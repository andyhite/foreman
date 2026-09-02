/**
 * `foreman deinit` — the inverse of `foreman init`: stops Foreman managing
 * the current repo.
 *
 * Two independent things get undone, and each is best-effort on its own:
 * the plugin activation (`plugin-activation.ts`'s `deactivateRepoPlugin`,
 * the same symlink-and-lock-entry pair `init` wrote) and the repo's entry in
 * `~/.foreman/config.json`. Either can be missing without the other — a repo
 * that was only ever `init`-ed with `--skip-plugin`, or one whose plugin
 * link survived a manual registry edit — so both are attempted and reported
 * rather than short-circuited on the first miss.
 *
 * `.git/info/exclude` is left untouched deliberately: the `/.omp/plugins/`
 * line it holds is harmless once the directory it names is gone, and
 * rewriting a file the operator may have hand-edited to remove one line
 * risks clobbering their edits for a cosmetic cleanup that buys nothing.
 */

import { type CommandRunner, expandHome, loadGlobalConfig, type RepoEntry } from "@foreman/core";
import { writeGlobalConfig } from "./global-config.ts";
import { deactivateRepoPlugin } from "./plugin-activation.ts";
import type { Prompter } from "./prompt.ts";
import { printSection, style } from "./tui.ts";

export interface DeinitOptions {
  cwd: string;
  home: string;
  /** Skip removing the repo's entry from `~/.foreman/config.json`. */
  keepRegistry: boolean;
}

export interface DeinitDeps {
  prompter: Prompter;
  log: (message: string) => void;
  git: CommandRunner;
}

/** `git rev-parse --show-toplevel`, so running from a subdirectory still finds the repo root. */
async function resolveRepoRoot(cwd: string, git: CommandRunner): Promise<string> {
  try {
    const { stdout } = await git.run(["git", "rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    if (root.length === 0) throw new Error("empty toplevel");
    return root;
  } catch {
    throw new Error("`foreman deinit` must be run inside a git repository.");
  }
}

/** The registry entry filed at `repoRoot`, keyed by whatever alias it's currently filed under. */
function findEntryByPath(
  repos: Record<string, RepoEntry>,
  repoRoot: string,
  home: string,
): { alias: string; entry: RepoEntry } | null {
  for (const [alias, entry] of Object.entries(repos)) {
    if (expandHome(entry.path, home) === repoRoot) return { alias, entry };
  }
  return null;
}

export async function runDeinit(options: DeinitOptions, deps: DeinitDeps): Promise<void> {
  printSection(deps.log, "Deactivate omp plugin (this repo only)");

  const repoRoot = await resolveRepoRoot(options.cwd, deps.git);
  const deactivation = deactivateRepoPlugin(repoRoot);

  if (!deactivation.linkRemoved && !deactivation.lockEntryRemoved) {
    deps.log(`  ${style("cyan", "i")} no plugin activation found at ${deactivation.linkPath} — nothing to remove.`);
  } else {
    if (deactivation.linkRemoved) deps.log(`  ${style("green", "✓")} removed symlink ${deactivation.linkPath}`);
    if (deactivation.lockRemoved) {
      deps.log(`  ${style("green", "✓")} removed ${deactivation.lockPath} (held nothing else).`);
    } else if (deactivation.lockEntryRemoved) {
      deps.log(`  ${style("green", "✓")} removed the lock entry from ${deactivation.lockPath} (other plugins remain).`);
    }
    if (deactivation.prunedDirs.length > 0) {
      deps.log(`  ${style("green", "✓")} pruned ${deactivation.prunedDirs.length} now-empty director${deactivation.prunedDirs.length === 1 ? "y" : "ies"}.`);
    }
  }

  printSection(deps.log, "Registry (config.repos)");

  if (options.keepRegistry) {
    deps.log("  skipped (--keep-registry).");
    return;
  }

  const existing = loadGlobalConfig({ home: options.home }).config;
  const match = findEntryByPath(existing.repos, repoRoot, options.home);
  if (!match) {
    deps.log(`  ${style("cyan", "i")} no registry entry found for ${repoRoot} — nothing to remove.`);
    return;
  }

  const confirmed = await deps.prompter.confirm(`Remove "${match.alias}" (${repoRoot}) from the registry?`, true);
  if (!confirmed) {
    deps.log("  left the registry entry in place.");
    return;
  }

  const configPath = writeGlobalConfig({ removeRepos: [match.alias] }, options.home);
  deps.log(`  wrote ${configPath}`);
  deps.log(`  ${style("green", "✓")} removed "${match.alias}" from the registry.`);
}
