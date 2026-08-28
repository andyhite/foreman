/**
 * `foreman setup` wizard body (SPEC §3.10, §3.1, §17.4).
 *
 * Four steps, each skippable independently: preflight tool checks, the
 * global config file, the omp plugin, and the optional herdr board. Nothing
 * here is a hard failure except a missing `bun` — everything else degrades
 * to a printed instruction so a partial environment still finishes with a
 * usable config.
 */

import { LinearApiError, LinearClient, type ProjectRef, type TeamRef } from "@foreman/core";
import { join } from "node:path";
import type { Runner } from "./exec.ts";
import { readGlobalConfig, writeGlobalConfig, writeLinearApiKeyFile } from "./global-config.ts";
import {
  DEFAULT_OMP_PLUGIN_NAME,
  herdrInstallArgv,
  herdrLinkArgv,
  type OmpScope,
  ompInstallArgv,
  ompLinkArgv,
  ompMarketplaceAddArgv,
} from "./plugin-commands.ts";
import type { CheckboxChoice, Prompter } from "./prompt.ts";
import { guessRepoPath } from "./repo-detect.ts";
import { printBanner, printSection, style } from "./tui.ts";

export type PluginMode = "link" | "install" | "skip";

export interface WizardOptions {
  home: string;
  repoRoot: string;
  githubRepo: string;
  scope: OmpScope | null;
  ompMode: PluginMode | null;
  herdrMode: PluginMode | null;
  skipBuild: boolean;
  skipLinear: boolean;
}

export interface WizardDeps {
  prompter: Prompter;
  runner: Runner;
  log: (message: string) => void;
}

async function preflight(deps: WizardDeps): Promise<void> {
  printSection(deps.log, "Checking tools");
  const required: Array<[string, string]> = [
    ["bun", "https://bun.sh"],
    ["git", "https://git-scm.com"],
  ];
  for (const [bin, url] of required) {
    if (!(await deps.runner.exists(bin))) {
      throw new Error(`${bin} is required and was not found on PATH. Install it: ${url}`);
    }
    deps.log(`  ${style("green", "✓")} ${bin}: found`);
  }
  const optional: Array<[string, string]> = [
    ["gh", "needed to open PRs — https://cli.github.com"],
    ["omp", "needed to install the omp plugin — https://github.com/andyhite/oh-my-pi"],
    ["herdr", "only needed for the optional board — https://github.com/andyhite/herdr"],
  ];
  for (const [bin, note] of optional) {
    const found = await deps.runner.exists(bin);
    const mark = found ? style("green", "✓") : style("dim", "○");
    deps.log(`  ${mark} ${bin}: ${found ? "found" : `not found (${note})`}`);
  }
}

/** Masks all but the last four characters, e.g. `lin_api_****************abcd`. */
function maskKey(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `${"*".repeat(Math.max(0, apiKey.length - 4))}${tail}`;
}

interface ResolvedApiKey {
  apiKey: string | null;
  apiKeyFile: string | null;
}

/**
 * `$LINEAR_API_KEY` wins over every prompt — it's already how the loop and
 * the extension resolve the key (README "Foreman reads the Linear personal
 * API key from `$LINEAR_API_KEY`, or from `linear.apiKeyFile`"), so a
 * present env var means the operator is already done configuring this and
 * asking again would just be noise.
 */
async function resolveLinearApiKey(
  prompter: Prompter,
  log: (message: string) => void,
  home: string,
  skipLinear: boolean,
): Promise<ResolvedApiKey> {
  const envKey = process.env.LINEAR_API_KEY;
  if (envKey) {
    log(`  ${style("green", "✓")} using $LINEAR_API_KEY from the environment (${maskKey(envKey)})`);
    return { apiKey: envKey, apiKeyFile: null };
  }
  if (skipLinear) {
    log("  skipping — set $LINEAR_API_KEY, or linear.apiKeyFile in the config, before starting the loop.");
    return { apiKey: null, apiKeyFile: null };
  }
  if (!(await prompter.confirm("Do you have a Linear personal API key to configure now?", true))) {
    log("  skipping — set $LINEAR_API_KEY, or linear.apiKeyFile in the config, before starting the loop.");
    return { apiKey: null, apiKeyFile: null };
  }
  const apiKey = await prompter.secret("Paste your Linear API key (input hidden): ");
  if (apiKey.length === 0) {
    log("  no key entered; set $LINEAR_API_KEY yourself before starting the loop.");
    return { apiKey: null, apiKeyFile: null };
  }
  const apiKeyFile = writeLinearApiKeyFile(apiKey, home);
  log(`  wrote ${apiKeyFile} (mode 0600)`);
  return { apiKey, apiKeyFile };
}

interface ProjectSelection {
  projects: Record<string, string>;
  teamKeys: string[];
}

/**
 * Fetches every project in the workspace and lets the operator check the
 * ones Foreman should manage, pre-checking projects already mapped in
 * `existingProjects` and pre-filling each repo path from `guessRepoPath` —
 * the operator confirms or edits rather than typing every path by hand.
 * Returns null on any API failure or an empty workspace so the caller can
 * fall back to manual entry instead of dead-ending the wizard.
 */
async function pickProjectsFromLinear(
  prompter: Prompter,
  log: (message: string) => void,
  apiKey: string,
  repoRoot: string,
  existingProjects: Record<string, string>,
): Promise<ProjectSelection | null> {
  const client = new LinearClient({ apiKey });
  let projects: ProjectRef[];
  let teams: TeamRef[];
  try {
    [projects, teams] = await Promise.all([client.projects(), client.teams()]);
  } catch (error) {
    const message = error instanceof LinearApiError ? error.message : String(error);
    log(`  ${style("yellow", "!")} couldn't reach the Linear API (${message}) — falling back to manual entry.`);
    return null;
  }
  if (projects.length === 0) {
    log(`  ${style("yellow", "!")} no projects found in this Linear workspace — falling back to manual entry.`);
    return null;
  }

  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const choices: Array<CheckboxChoice<string>> = sorted.map((project) => {
    const mappedPath = existingProjects[project.id];
    return {
      value: project.id,
      label: project.name,
      checked: mappedPath !== undefined,
      hint: mappedPath ? `already mapped → ${mappedPath}` : undefined,
    };
  });

  const selectedIds = await prompter.multiSelect("Which Linear projects should Foreman manage?", choices);
  const projectsById = new Map(sorted.map((project) => [project.id, project] as const));
  const mapped: Record<string, string> = {};
  for (const id of selectedIds) {
    const project = projectsById.get(id);
    if (!project) continue;
    const suggestion = existingProjects[id] ?? guessRepoPath(project.name, repoRoot) ?? "";
    const repoPath = await prompter.text(`Repo path for "${project.name}"`, suggestion);
    if (repoPath.length > 0) mapped[id] = repoPath;
  }

  return { projects: mapped, teamKeys: teams.map((team) => team.key) };
}

/** The pre-API fallback: a project-id/repo-path loop, team keys are prompted separately. */
async function pickProjectsManually(prompter: Prompter): Promise<Record<string, string>> {
  const mapped: Record<string, string> = {};
  if (await prompter.confirm("Map a Linear project id to a repo path now?", false)) {
    for (;;) {
      const projectId = await prompter.text("Linear project id (blank to stop)", "");
      if (projectId.length === 0) break;
      const repoPath = await prompter.text(`Repo path for project ${projectId}`, "");
      if (repoPath.length > 0) mapped[projectId] = repoPath;
      if (!(await prompter.confirm("Map another project?", false))) break;
    }
  }
  return mapped;
}

async function configureGlobalConfig(
  prompter: Prompter,
  log: (message: string) => void,
  home: string,
  skipLinear: boolean,
  repoRoot: string,
): Promise<void> {
  printSection(log, "Global config (~/.foreman/config.json)");

  const { apiKey, apiKeyFile } = await resolveLinearApiKey(prompter, log, home, skipLinear);
  const existing = readGlobalConfig(home);

  const picked = apiKey ? await pickProjectsFromLinear(prompter, log, apiKey, repoRoot, existing.projects) : null;
  const manuallyMapped = picked ? {} : await pickProjectsManually(prompter);
  const projects = { ...existing.projects, ...(picked?.projects ?? manuallyMapped) };

  const suggestedTeamKeys = existing.teamKeys.length > 0 ? existing.teamKeys : (picked?.teamKeys ?? []);
  const teamKeysRaw = await prompter.text(
    "Linear team keys to manage, comma-separated (blank = every team)",
    suggestedTeamKeys.join(", "),
  );
  const teamKeys = teamKeysRaw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  const configPath = writeGlobalConfig({ projects, linear: { teamKeys, apiKeyFile } }, home);
  log(`  wrote ${configPath}`);
  const projectCount = Object.keys(projects).length;
  if (projectCount === 0) {
    log('  no projects mapped yet — add them under "projects" before the loop can dispatch anything.');
  } else {
    log(`  ${style("green", "✓")} ${projectCount} project(s) mapped to a repo.`);
  }
}

async function buildRepo(deps: WizardDeps, repoRoot: string, skipBuild: boolean): Promise<void> {
  if (skipBuild) return;
  printSection(deps.log, "Building the checkout");
  deps.log("  bun install");
  if ((await deps.runner.run("bun", ["install"], { cwd: repoRoot })) !== 0) {
    throw new Error("bun install failed; fix the error above and re-run `foreman setup`.");
  }
  deps.log("  bun run build");
  if ((await deps.runner.run("bun", ["run", "build"], { cwd: repoRoot })) !== 0) {
    throw new Error("bun run build failed; fix the error above and re-run `foreman setup`.");
  }
}

async function resolvePluginMode(
  prompter: Prompter,
  pluginLabel: string,
  explicit: PluginMode | null,
  defaultMode: PluginMode,
): Promise<PluginMode> {
  if (explicit) return explicit;
  return prompter.select(
    `Install the ${pluginLabel}?`,
    [
      { value: "link" as const, label: "Dev mode — symlink this checkout (live edits, no rebuild-to-see-changes)" },
      { value: "install" as const, label: "Install — fetch and register from GitHub" },
      { value: "skip" as const, label: "Skip" },
    ],
    defaultMode,
  );
}

async function setupOmpPlugin(deps: WizardDeps, options: WizardOptions, mode: PluginMode): Promise<void> {
  printSection(deps.log, "omp plugin");
  if (mode === "skip") {
    deps.log("  skipped.");
    return;
  }

  const scope =
    options.scope ??
    (await deps.prompter.select(
      "Install scope?",
      [
        { value: "user" as const, label: "user — applies across every repo you work in" },
        { value: "project" as const, label: "project — this repo only" },
      ],
      "user",
    ));

  if (mode === "link") {
    const pluginDir = join(options.repoRoot, "packages", "omp-plugin");
    const code = await deps.runner.run("omp", ompLinkArgv(pluginDir, scope));
    if (code !== 0) throw new Error("omp plugin link failed.");
    deps.log(`  ${style("green", "✓")} linked ${pluginDir} (scope: ${scope})`);
    return;
  }

  const marketplaceCode = await deps.runner.run("omp", ompMarketplaceAddArgv(options.githubRepo));
  if (marketplaceCode !== 0) throw new Error("omp plugin marketplace add failed.");
  const installCode = await deps.runner.run(
    "omp",
    ompInstallArgv(DEFAULT_OMP_PLUGIN_NAME, options.githubRepo, scope),
  );
  if (installCode !== 0) throw new Error("omp plugin install failed.");
  deps.log(`  ${style("green", "✓")} installed from ${options.githubRepo} (scope: ${scope})`);
}

async function setupHerdrPlugin(deps: WizardDeps, options: WizardOptions, mode: PluginMode): Promise<void> {
  printSection(deps.log, "herdr board (optional)");
  if (mode === "skip") {
    deps.log("  skipped.");
    return;
  }
  if (!(await deps.runner.exists("herdr"))) {
    deps.log("  herdr is not on PATH — install it first: https://github.com/andyhite/herdr");
    return;
  }

  if (mode === "link") {
    const pluginDir = join(options.repoRoot, "packages", "herdr-plugin");
    const code = await deps.runner.run("herdr", herdrLinkArgv(pluginDir));
    if (code !== 0) throw new Error("herdr plugin link failed.");
    deps.log(`  ${style("green", "✓")} linked ${pluginDir}`);
    return;
  }

  const code = await deps.runner.run("herdr", herdrInstallArgv(options.githubRepo, "packages/herdr-plugin"));
  if (code !== 0) throw new Error("herdr plugin install failed.");
  deps.log(`  ${style("green", "✓")} installed from ${options.githubRepo}/packages/herdr-plugin`);
}

export async function runWizard(options: WizardOptions, deps: WizardDeps): Promise<void> {
  printBanner(deps.log);
  await preflight(deps);
  await configureGlobalConfig(deps.prompter, deps.log, options.home, options.skipLinear, options.repoRoot);

  const herdrFound = await deps.runner.exists("herdr");
  const ompMode = await resolvePluginMode(deps.prompter, "omp plugin (agents, commands, gates)", options.ompMode, "link");
  const herdrMode = await resolvePluginMode(
    deps.prompter,
    "herdr board (blocked drain, proposal review, board, agent detail)",
    options.herdrMode,
    herdrFound ? "link" : "skip",
  );

  const needsBuild = ompMode === "link" || herdrMode === "link";
  await buildRepo(deps, options.repoRoot, options.skipBuild || !needsBuild);

  await setupOmpPlugin(deps, options, ompMode);
  await setupHerdrPlugin(deps, options, herdrMode);

  printSection(deps.log, "Done");
  deps.log(`  ${style("green", "✓")} Edit ~/.foreman/config.json to map more Linear projects to repos.`);
  deps.log(`  ${style("cyan", "→")} Then: foreman loop --dry-run --once --verbose`);
}
