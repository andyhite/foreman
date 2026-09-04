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

import {
  type CommandRunner,
  deactivateRepoPlugin,
  describeLinearError,
  expandHome,
  LinearClient,
  loadGlobalConfig,
  MANAGED_STATES,
  resolveLinearApiKey,
  type ProvisionAction,
  type RepoEntry,
} from "@foreman/core";
import { writeGlobalConfig } from "./global-config.ts";
import type { Prompter } from "./prompt.ts";
import { printProvisionActions, printProvisionLegend, promptConfirmer } from "./provision-report.ts";
import { printSection, style } from "./tui.ts";

export interface DeinitOptions {
  cwd: string;
  home: string;
  /** Skip removing the repo's entry from `~/.foreman/config.json`. */
  keepRegistry: boolean;
  /** Also archive the Foreman-managed workflow states `foreman init` created on this repo's Linear team. */
  revertLinear: boolean;
  /** Accept defaults for every prompt (non-interactive); also discloses auto-approval when archiving workflow states. */
  yes: boolean;
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

  if (
    !deactivation.linkRemoved &&
    !deactivation.lockEntryRemoved &&
    !deactivation.installedPluginsEntryRemoved
  ) {
    deps.log(`  ${style("cyan", "i")} no plugin activation found at ${deactivation.linkPath} — nothing to remove.`);
  } else {
    if (deactivation.linkRemoved) deps.log(`  ${style("green", "✓")} removed symlink ${deactivation.linkPath}`);
    if (deactivation.lockRemoved) {
      deps.log(`  ${style("green", "✓")} removed ${deactivation.lockPath} (held nothing else).`);
    } else if (deactivation.lockEntryRemoved) {
      deps.log(`  ${style("green", "✓")} removed the lock entry from ${deactivation.lockPath} (other plugins remain).`);
    }
    if (deactivation.installedPluginsRemoved) {
      deps.log(`  ${style("green", "✓")} removed ${deactivation.installedPluginsPath} (held nothing else).`);
    } else if (deactivation.installedPluginsEntryRemoved) {
      deps.log(
        `  ${style("green", "✓")} removed the "foreman:" command namespace entry from ${deactivation.installedPluginsPath} (other plugins remain).`,
      );
    }
    if (deactivation.prunedDirs.length > 0) {
      deps.log(`  ${style("green", "✓")} pruned ${deactivation.prunedDirs.length} now-empty director${deactivation.prunedDirs.length === 1 ? "y" : "ies"}.`);
    }
  }

  printSection(deps.log, "Registry (config.repos)");

  const existing = loadGlobalConfig({ home: options.home }).config;
  const match = findEntryByPath(existing.repos, repoRoot, options.home);

  if (options.keepRegistry) {
    deps.log("  skipped (--keep-registry).");
  } else if (!match) {
    deps.log(`  ${style("cyan", "i")} no registry entry found for ${repoRoot} — nothing to remove.`);
  } else {
    const confirmed = await deps.prompter.confirm(`Remove "${match.alias}" (${repoRoot}) from the registry?`, true);
    if (!confirmed) {
      deps.log("  left the registry entry in place.");
    } else {
      const configPath = writeGlobalConfig({ removeRepos: [match.alias] }, options.home);
      deps.log(`  wrote ${configPath}`);
      deps.log(`  ${style("green", "✓")} removed "${match.alias}" from the registry.`);
    }
  }

  printSection(deps.log, "Linear cleanup");

  if (!options.revertLinear) {
    deps.log("  skipped (pass --revert-linear to archive the workflow states init created).");
    return;
  }

  if (!match) {
    deps.log(`  ${style("cyan", "i")} skipped, no registry entry for ${repoRoot} — nothing to revert.`);
    return;
  }

  let apiKey: string;
  try {
    apiKey = resolveLinearApiKey(existing, process.env, options.home);
  } catch (error) {
    deps.log(`  skipped, no Linear credential — ${describeLinearError(error)}`);
    return;
  }

  const client = new LinearClient({ apiKey });
  let team: { id: string; key: string } | undefined;
  try {
    const teams = await client.teams();
    team = teams.find((candidate) => candidate.key === match.entry.team);
  } catch (error) {
    deps.log(`  ${style("yellow", "!")} could not look up team ${match.entry.team} — ${describeLinearError(error)}`);
    return;
  }
  if (!team) {
    deps.log(`  ${style("cyan", "i")} skipped, Linear team "${match.entry.team}" does not exist in this workspace.`);
    return;
  }

  const managedNames = new Set(MANAGED_STATES.map((spec) => spec.name.toLowerCase()));
  const states = await client.workflowStates(team.id);
  const managedStates = states.filter((state) => managedNames.has(state.name.trim().toLowerCase()));

  const counted: Array<{ id: string; name: string; issueCount: number }> = [];
  for (const state of managedStates) {
    const issues = await client.issues({ filter: { state: { id: { eq: state.id } } }, limit: 250 });
    counted.push({ id: state.id, name: state.name, issueCount: issues.length });
  }

  const archivable = counted.filter((state) => state.issueCount === 0);
  const holdingIssues = counted.filter((state) => state.issueCount > 0);

  printProvisionLegend(deps.log);

  let proceed = archivable.length === 0;
  if (archivable.length > 0) {
    const confirmer = promptConfirmer(deps.prompter, deps.log, options.yes);
    proceed = await confirmer.confirm({
      kind: "linear-write",
      summary: `Archive ${archivable.length} Foreman workflow state(s) on team ${match.entry.team}`,
      detail: archivable.map((state) => `- ${state.name}`),
    });
    confirmer.close();
  }

  const actions: ProvisionAction[] = [];
  for (const state of archivable) {
    if (!proceed) {
      actions.push({ kind: "state", name: state.name, op: "archive", changed: false, detail: "declined" });
      continue;
    }
    try {
      await client.archiveWorkflowState(state.id);
      actions.push({ kind: "state", name: state.name, op: "archive", changed: true, detail: null });
    } catch (error) {
      actions.push({ kind: "state", name: state.name, op: "archive", changed: false, detail: describeLinearError(error) });
    }
  }
  for (const state of holdingIssues) {
    actions.push({ kind: "state", name: state.name, op: "archive", changed: false, detail: `still holds ${state.issueCount} issue(s)` });
  }

  printProvisionActions(deps.log, actions);

  deps.log(`  ${style("cyan", "i")} Left in place (Linear has no delete for these): the \`type:*\` and \`app:*\` labels,`);
  deps.log("    the team's triage/cycles settings, and the product Context doc. Remove them in Linear if you want them gone.");
}
