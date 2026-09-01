/**
 * `foreman setup` wizard body (SPEC §3.10, §3.1, §17.4).
 *
 * Per-machine only: tool preflight, the Linear API key, the omp marketplace
 * catalog, and (with `--link`) the foreman CLI dev shim. It never installs
 * or links the omp plugin itself and never touches the `repos` registry —
 * the plugin only makes sense scoped to a specific repo (see
 * plugin-commands.ts), so `foreman init` is what installs it, once per
 * repo, after this has registered the marketplace it installs from.
 * Nothing here is a hard failure except a missing `bun` — everything else
 * degrades to a printed instruction so a partial environment still
 * finishes with a usable config.
 */

import { cliBinDir, writeCliBinLink } from "./cli-link.ts";
import type { Runner } from "./exec.ts";
import { writeGlobalConfig, writeLinearApiKeyFile } from "./global-config.ts";
import { FOREMAN_MARKETPLACE_NAME, ompMarketplaceAddArgv, ompMarketplaceListArgv } from "./plugin-commands.ts";
import type { Prompter } from "./prompt.ts";
import { printBanner, printSection, style } from "./tui.ts";

export interface WizardOptions {
  home: string;
  checkoutRoot: string;
  githubRepo: string;
  /** Link the foreman CLI itself to this checkout's source (no rebuild-to-see-changes). */
  linkCli: boolean;
  skipLinear: boolean;
}

export interface WizardDeps {
  prompter: Prompter;
  runner: Runner;
  log: (message: string) => void;
}

interface PreflightResult {
  missingGh: boolean;
  hasOmp: boolean;
}

async function preflight(deps: WizardDeps): Promise<PreflightResult> {
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
  const hasOmp = await deps.runner.exists("omp");
  const mark = hasOmp ? style("green", "✓") : style("dim", "○");
  const note = "needed to install the omp plugin — https://github.com/andyhite/oh-my-pi";
  deps.log(`  ${mark} omp: ${hasOmp ? "found" : `not found (${note})`}`);
  const hasHerdr = await deps.runner.exists("herdr");
  const herdrMark = hasHerdr ? style("green", "✓") : style("dim", "○");
  deps.log(`  ${herdrMark} herdr: ${hasHerdr ? "found" : "not found (optional — the loop dispatches into real herdr panes automatically when reachable, https://github.com/andyhite/herdr)"}`);
  return { missingGh, hasOmp };
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
  const apiKey = (await prompter.secret("Paste your Linear API key (input hidden): ")).trim();
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

async function marketplaceAlreadyRegistered(deps: WizardDeps, githubRepo: string): Promise<boolean> {
  const { code, stdout } = await deps.runner.capture("omp", ompMarketplaceListArgv());
  if (code !== 0) return false;
  return stdout.includes(FOREMAN_MARKETPLACE_NAME) || stdout.includes(githubRepo);
}

/**
 * Registers the marketplace catalog `foreman init` installs the plugin
 * from — the sole per-machine omp step left after the project-scope
 * cutover. omp only has a catalog to add here; no plugin install or link
 * happens until a repo runs `foreman init` (plugin-commands.ts).
 */
async function registerMarketplace(deps: WizardDeps, options: WizardOptions, hasOmp: boolean): Promise<void> {
  printSection(deps.log, "omp marketplace");
  if (!hasOmp) {
    deps.log(
      `  omp not found on PATH — skipped. Install omp, then re-run \`foreman setup\`, and \`foreman init\` will install the plugin per repo.`,
    );
    return;
  }
  if (await marketplaceAlreadyRegistered(deps, options.githubRepo)) {
    deps.log(`  ${style("cyan", "i")} marketplace "${FOREMAN_MARKETPLACE_NAME}" is already registered.`);
    return;
  }
  const argv = ompMarketplaceAddArgv(options.githubRepo);
  const code = await deps.runner.run("omp", argv);
  if (code !== 0 && !(await marketplaceAlreadyRegistered(deps, options.githubRepo))) {
    throw new Error(
      `omp plugin marketplace add failed (exit ${code}): \`omp ${argv.join(" ")}\`. The command's output is above. ` +
        "Common causes: no network, or `omp` not authenticated.",
    );
  }
  deps.log(`  ${style("green", "✓")} registered ${options.githubRepo} as marketplace "${FOREMAN_MARKETPLACE_NAME}".`);
}

export async function runWizard(options: WizardOptions, deps: WizardDeps): Promise<void> {
  printBanner(deps.log);
  const { missingGh, hasOmp } = await preflight(deps);
  await configureGlobalConfig(deps.prompter, deps.log, options.home, options.skipLinear);
  await registerMarketplace(deps, options, hasOmp);

  if (options.linkCli) {
    printSection(deps.log, "foreman CLI (dev mode)");
    const binPath = writeCliBinLink(options.checkoutRoot, options.home);
    deps.log(`  ${style("green", "✓")} wrote ${binPath} → runs packages/cli/src/main.ts straight from source (no rebuild needed)`);
    const dir = cliBinDir(options.home);
    if (!(process.env.PATH ?? "").split(":").includes(dir)) {
      deps.log(`  ${style("yellow", "!")} ${dir} isn't on your PATH yet. Add it, e.g.:`);
      deps.log(`    export PATH="${dir}:$PATH"`);
    }
  }

  printSection(deps.log, "Done");
  deps.log(`  ${style("green", "✓")} Machine setup complete.`);
  deps.log(`  ${style("cyan", "→")} Then: cd into a repo and run \`foreman init\` to register it and install the omp plugin there.`);
  if (missingGh) {
    deps.log(`  ${style("yellow", "!")} gh not found — Foreman cannot open PRs until you install it: https://cli.github.com`);
  }
}
