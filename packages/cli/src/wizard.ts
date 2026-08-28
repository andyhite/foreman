/**
 * `foreman setup` wizard body (SPEC §3.10, §3.1, §17.4).
 *
 * Four steps, each skippable independently: preflight tool checks, the
 * global config file, the omp plugin, and the optional herdr board. Nothing
 * here is a hard failure except a missing `bun` — everything else degrades
 * to a printed instruction so a partial environment still finishes with a
 * usable config.
 */

import { join } from "node:path";
import type { Runner } from "./exec.ts";
import { writeGlobalConfig, writeLinearApiKeyFile } from "./global-config.ts";
import {
  DEFAULT_OMP_PLUGIN_NAME,
  herdrInstallArgv,
  herdrLinkArgv,
  type OmpScope,
  ompInstallArgv,
  ompLinkArgv,
  ompMarketplaceAddArgv,
} from "./plugin-commands.ts";
import type { Prompter } from "./prompt.ts";

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

function section(log: (message: string) => void, title: string): void {
  log("");
  log(`── ${title} ──`);
}

async function preflight(deps: WizardDeps): Promise<void> {
  section(deps.log, "Checking tools");
  const required: Array<[string, string]> = [
    ["bun", "https://bun.sh"],
    ["git", "https://git-scm.com"],
  ];
  for (const [bin, url] of required) {
    if (!(await deps.runner.exists(bin))) {
      throw new Error(`${bin} is required and was not found on PATH. Install it: ${url}`);
    }
    deps.log(`  ${bin}: found`);
  }
  const optional: Array<[string, string]> = [
    ["gh", "needed to open PRs — https://cli.github.com"],
    ["omp", "needed to install the omp plugin — https://github.com/andyhite/oh-my-pi"],
    ["herdr", "only needed for the optional board — https://github.com/andyhite/herdr"],
  ];
  for (const [bin, note] of optional) {
    const found = await deps.runner.exists(bin);
    deps.log(`  ${bin}: ${found ? "found" : `not found (${note})`}`);
  }
}

async function configureGlobalConfig(
  prompter: Prompter,
  log: (message: string) => void,
  home: string,
  skipLinear: boolean,
): Promise<void> {
  section(log, "Global config (~/.foreman/config.json)");

  let apiKeyFile: string | null = null;
  if (!skipLinear && (await prompter.confirm("Do you have a Linear personal API key to configure now?", true))) {
    const apiKey = await prompter.secret("Paste your Linear API key (input hidden): ");
    if (apiKey.length > 0) {
      apiKeyFile = writeLinearApiKeyFile(apiKey, home);
      log(`  wrote ${apiKeyFile} (mode 0600)`);
    } else {
      log("  no key entered; set $LINEAR_API_KEY yourself before starting the loop.");
    }
  } else {
    log("  skipping — set $LINEAR_API_KEY, or linear.apiKeyFile in the config, before starting the loop.");
  }

  const teamKeysRaw = await prompter.text(
    "Linear team keys to manage, comma-separated (blank = every team)",
    "",
  );
  const teamKeys = teamKeysRaw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  const projects: Record<string, string> = {};
  if (await prompter.confirm("Map a Linear project id to a repo path now?", false)) {
    for (;;) {
      const projectId = await prompter.text("Linear project id (blank to stop)", "");
      if (projectId.length === 0) break;
      const repoPath = await prompter.text(`Repo path for project ${projectId}`, "");
      if (repoPath.length > 0) projects[projectId] = repoPath;
      if (!(await prompter.confirm("Map another project?", false))) break;
    }
  }

  const configPath = writeGlobalConfig({ projects, linear: { teamKeys, apiKeyFile } }, home);
  log(`  wrote ${configPath}`);
  if (Object.keys(projects).length === 0) {
    log("  no projects mapped yet — add them under \"projects\" before the loop can dispatch anything.");
  }
}

async function buildRepo(deps: WizardDeps, repoRoot: string, skipBuild: boolean): Promise<void> {
  if (skipBuild) return;
  section(deps.log, "Building the checkout");
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
  section(deps.log, "omp plugin");
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
    deps.log(`  linked ${pluginDir} (scope: ${scope})`);
    return;
  }

  const marketplaceCode = await deps.runner.run("omp", ompMarketplaceAddArgv(options.githubRepo));
  if (marketplaceCode !== 0) throw new Error("omp plugin marketplace add failed.");
  const installCode = await deps.runner.run(
    "omp",
    ompInstallArgv(DEFAULT_OMP_PLUGIN_NAME, options.githubRepo, scope),
  );
  if (installCode !== 0) throw new Error("omp plugin install failed.");
  deps.log(`  installed from ${options.githubRepo} (scope: ${scope})`);
}

async function setupHerdrPlugin(deps: WizardDeps, options: WizardOptions, mode: PluginMode): Promise<void> {
  section(deps.log, "herdr board (optional)");
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
    deps.log(`  linked ${pluginDir}`);
    return;
  }

  const code = await deps.runner.run("herdr", herdrInstallArgv(options.githubRepo, "packages/herdr-plugin"));
  if (code !== 0) throw new Error("herdr plugin install failed.");
  deps.log(`  installed from ${options.githubRepo}/packages/herdr-plugin`);
}

export async function runWizard(options: WizardOptions, deps: WizardDeps): Promise<void> {
  await preflight(deps);
  await configureGlobalConfig(deps.prompter, deps.log, options.home, options.skipLinear);

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

  section(deps.log, "Done");
  deps.log("  Edit ~/.foreman/config.json to map more Linear projects to repos.");
  deps.log("  Then: foreman loop --dry-run --once --verbose");
}
