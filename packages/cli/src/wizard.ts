/**
 * `foreman setup` wizard body (SPEC §3.10, §3.1, §17.4).
 *
 * Three steps, each skippable independently: preflight tool checks, the
 * Linear API key, and the omp plugin plus optional herdr board. Nothing
 * here is a hard failure except a missing `bun` — everything else degrades
 * to a printed instruction so a partial environment still finishes with a
 * usable config. This wizard is global only: it never touches the `repos`
 * registry — run `foreman init` inside a repo to register it.
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

async function preflight(deps: WizardDeps): Promise<boolean> {
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
  const recommended: Array<[string, string]> = [["gh", "needed to open PRs — https://cli.github.com"]];
  let missingGh = false;
  for (const [bin, note] of recommended) {
    const found = await deps.runner.exists(bin);
    if (!found) missingGh = true;
    const mark = found ? style("green", "✓") : style("yellow", "!");
    deps.log(`  ${mark} ${bin}: ${found ? "found" : `not found (${note})`}`);
  }
  const optional: Array<[string, string]> = [
    ["omp", "needed to install the omp plugin — https://github.com/andyhite/oh-my-pi"],
    ["herdr", "only needed for the optional board — https://github.com/andyhite/herdr"],
  ];
  for (const [bin, note] of optional) {
    const found = await deps.runner.exists(bin);
    const mark = found ? style("green", "✓") : style("dim", "○");
    deps.log(`  ${mark} ${bin}: ${found ? "found" : `not found (${note})`}`);
  }
  return missingGh;
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

async function configureGlobalConfig(
  prompter: Prompter,
  log: (message: string) => void,
  home: string,
  skipLinear: boolean,
): Promise<void> {
  printSection(log, "Linear API key (~/.foreman/config.json)");

  const { apiKeyFile } = await resolveLinearApiKey(prompter, log, home, skipLinear);

  const configPath = writeGlobalConfig({ linear: { apiKeyFile } }, home);
  log(`  wrote ${configPath}`);
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
    const argv = ompLinkArgv(pluginDir, scope);
    const code = await deps.runner.run("omp", argv);
    if (code !== 0) {
      throw new Error(
        `omp plugin link failed (exit ${code}): \`omp ${argv.join(" ")}\`. The command's output is above. ` +
          "Common causes: the omp CLI isn't authenticated, or another plugin is already linked at that scope.",
      );
    }
    deps.log(`  ${style("green", "✓")} linked ${pluginDir} (scope: ${scope})`);
    return;
  }

  const marketplaceArgv = ompMarketplaceAddArgv(options.githubRepo);
  const marketplaceCode = await deps.runner.run("omp", marketplaceArgv);
  if (marketplaceCode !== 0) {
    throw new Error(
      `omp plugin marketplace add failed (exit ${marketplaceCode}): \`omp ${marketplaceArgv.join(" ")}\`. ` +
        "The command's output is above. Common causes: no network, or `omp` not authenticated.",
    );
  }
  const installArgv = ompInstallArgv(DEFAULT_OMP_PLUGIN_NAME, options.githubRepo, scope);
  const installCode = await deps.runner.run("omp", installArgv);
  if (installCode !== 0) {
    throw new Error(
      `omp plugin install failed (exit ${installCode}): \`omp ${installArgv.join(" ")}\`. ` +
        "The command's output is above. Common causes: no network, or `omp` not authenticated.",
    );
  }
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
    const argv = herdrLinkArgv(pluginDir);
    const code = await deps.runner.run("herdr", argv);
    if (code !== 0) {
      throw new Error(
        `herdr plugin link failed (exit ${code}): \`herdr ${argv.join(" ")}\`. The command's output is above. ` +
          "Common causes: herdr isn't installed correctly, or another plugin is already linked there.",
      );
    }
    deps.log(`  ${style("green", "✓")} linked ${pluginDir}`);
    return;
  }

  const herdrArgv = herdrInstallArgv(options.githubRepo, "packages/herdr-plugin");
  const code = await deps.runner.run("herdr", herdrArgv);
  if (code !== 0) {
    throw new Error(
      `herdr plugin install failed (exit ${code}): \`herdr ${herdrArgv.join(" ")}\`. ` +
        "The command's output is above. Common causes: no network, or the repo isn't reachable on GitHub.",
    );
  }
  deps.log(`  ${style("green", "✓")} installed from ${options.githubRepo}/packages/herdr-plugin`);
}

export async function runWizard(options: WizardOptions, deps: WizardDeps): Promise<void> {
  printBanner(deps.log);
  const missingGh = await preflight(deps);
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

  printSection(deps.log, "Done");
  deps.log(`  ${style("green", "✓")} Global setup complete.`);
  deps.log(`  ${style("cyan", "→")} Then: cd into a repo and run \`foreman init\` to register it.`);
  if (missingGh) {
    deps.log(`  ${style("yellow", "!")} gh not found — Foreman cannot open PRs until you install it: https://cli.github.com`);
  }
}
