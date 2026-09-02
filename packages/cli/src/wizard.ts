/**
 * `foreman setup` wizard body (SPEC §3.10, §3.1, §17.4).
 *
 * Per-machine only: tool preflight, the Linear API key, the one global omp
 * plugin link, and (with `--link`) the foreman CLI dev shim. This is
 * deliberately the *only* place that ever calls `omp` at all, and even here
 * it never does — `writeGlobalPluginLink` just points `~/.foreman/plugin` at
 * this checkout's `packages/omp-plugin` with a symlink. There is no
 * marketplace, no plugin cache, and no network involved: omp discovers a
 * project plugin from a lock file plus a `node_modules` symlink alone (see
 * plugin-activation.ts for the full case), so the only thing a *machine*
 * needs is one stable place for those per-repo symlinks to point at. Setting
 * that up is `foreman init`'s job, once per repo, after this has run.
 *
 * The other machine-state task here is the opposite of installing anything:
 * `omp plugin link` (the command this design does *not* use, precisely
 * because of this) silently installs user-wide even when asked for project
 * scope, so this also detects and removes a stray machine-wide install on
 * every run — see `findUserScopeInstall` for why that's worth checking
 * every time rather than once.
 *
 * Nothing here is a hard failure except a missing `bun` or `git`; everything
 * else degrades to a printed instruction so a partial environment still
 * finishes with a usable config.
 */

import { cliBinDir, writeCliBinLink } from "./cli-link.ts";
import type { Runner } from "./exec.ts";
import { writeGlobalConfig, writeLinearApiKeyFile } from "./global-config.ts";
import { findUserScopeInstall, removeUserScopeInstall, writeGlobalPluginLink } from "./plugin-activation.ts";
import type { Prompter } from "./prompt.ts";
import { printBanner, printSection, style } from "./tui.ts";

export interface WizardOptions {
  home: string;
  checkoutRoot: string;
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
  const note = "omp is what actually runs the plugin — https://github.com/andyhite/oh-my-pi";
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

/**
 * Points the one global plugin link at this checkout, and reports what it
 * found — the sole per-machine omp step there is, now that a project plugin
 * root is two files `foreman init` writes with no omp involvement at all.
 */
async function linkGlobalPlugin(deps: WizardDeps, options: WizardOptions): Promise<void> {
  printSection(deps.log, "Foreman plugin (global)");
  const result = writeGlobalPluginLink(options.checkoutRoot, options.home);
  if (result.changed) {
    deps.log(`  ${style("green", "✓")} linked ${result.path} → ${result.target}`);
  } else {
    deps.log(`  ${style("cyan", "i")} ${result.path} already points at ${result.target}`);
  }
  deps.log("  every repo `foreman init` registers links to this path, so the plugin is active only there.");
}

/**
 * Undoes a stray machine-wide install — `omp plugin link` silently writes
 * one even when asked for project scope (see the module header), so this
 * checks and self-heals on every run rather than trusting it was never hit.
 */
async function removeStrayUserScopeInstall(deps: WizardDeps, options: WizardOptions): Promise<void> {
  const install = findUserScopeInstall(options.home);
  if (!install) return;
  printSection(deps.log, "Machine-wide install found");
  deps.log(
    `  ${style("yellow", "!")} ${install.root} carries a machine-wide Foreman install — that makes its rules, ` +
      "skills, and agents fire in every repo on this machine, not just registered ones.",
  );
  const confirmed = await deps.prompter.confirm("Remove the machine-wide install?", true);
  if (!confirmed) {
    deps.log("  left in place — re-run `foreman setup` to remove it later.");
    return;
  }
  const { lockChanged, linkRemoved } = removeUserScopeInstall(install);
  if (lockChanged) deps.log(`  ${style("green", "✓")} removed the lock entry from ${install.lockPath}`);
  if (linkRemoved) deps.log(`  ${style("green", "✓")} removed the leftover symlink at ${install.linkPath}`);
}

export async function runWizard(options: WizardOptions, deps: WizardDeps): Promise<void> {
  printBanner(deps.log);
  const { missingGh } = await preflight(deps);
  await configureGlobalConfig(deps.prompter, deps.log, options.home, options.skipLinear);
  await linkGlobalPlugin(deps, options);
  await removeStrayUserScopeInstall(deps, options);

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
  deps.log(`  ${style("cyan", "→")} Then: cd into a repo and run \`foreman init\` to register it and activate the plugin there.`);
  deps.log(`  ${style("cyan", "→")} Run \`foreman doctor\` any time to verify the plugin link is healthy.`);
  if (missingGh) {
    deps.log(`  ${style("yellow", "!")} gh not found — Foreman cannot open PRs until you install it: https://cli.github.com`);
  }
}
