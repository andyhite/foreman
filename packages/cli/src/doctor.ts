/**
 * `foreman doctor` — verifies the activation surface plugin-activation.ts
 * writes, rather than trusting it stayed intact.
 *
 * That surface is deliberately small (one global symlink, one lock entry and
 * one symlink per repo) but every piece of it is invisible in day-to-day use:
 * omp loads the plugin silently when the surface is healthy and silently
 * skips it when the surface has drifted. A moved checkout, a stray
 * machine-wide install left over from an old
 * `omp plugin link`, or a repo whose `.omp/plugins` got deleted by a clean-up
 * script all produce the same symptom: an agent that quietly lacks Foreman's
 * tools, discovered only when a skill or command mysteriously isn't there.
 * `doctor` turns that silence into a report, and `--fix` turns the report
 * into a repair using the same primitives `setup`/`init` use, so there is
 * exactly one code path that knows how to make the surface healthy.
 */

import {
  activateRepoPlugin,
  ensureGitExclude,
  expandHome,
  findUserScopeInstall,
  inspectRepoActivation,
  loadGlobalConfig,
  readGlobalPluginLink,
  removeUserScopeInstall,
  writeGlobalPluginLink,
} from "@foreman/core";
import { existsSync, statSync } from "node:fs";
import { findCheckoutRoot } from "./checkout.ts";
import { readGlobalConfig } from "./global-config.ts";
import type { Runner } from "./exec.ts";
import { printSection, style, statusLine } from "./tui.ts";

export interface DoctorOptions {
  home: string;
  checkoutRoot: string | null;
  fix: boolean;
}

export interface DoctorDeps {
  runner: Runner;
  log: (message: string) => void;
}

/** Resolves a checkout root for `--fix` repairs, without throwing when none is found. */
function resolveCheckoutForFix(options: DoctorOptions): string | null {
  if (options.checkoutRoot) return options.checkoutRoot;
  try {
    return findCheckoutRoot();
  } catch {
    return null;
  }
}

/** Counts a problem, and prints it prefixed with `!`/`✗` styling via `statusLine`. */
function report(deps: DoctorDeps, problems: string[], message: string): void {
  problems.push(message);
  deps.log(statusLine(false, message));
}

async function checkTools(options: DoctorOptions, deps: DoctorDeps, problems: string[]): Promise<void> {
  printSection(deps.log, "Tools");
  for (const bin of ["bun", "git"]) {
    const found = await deps.runner.exists(bin);
    if (found) deps.log(statusLine(true, `${bin}: found`));
    else report(deps, problems, `${bin}: not found on PATH — required for Foreman to run at all`);
  }
  for (const bin of ["omp", "gh", "herdr"]) {
    const found = await deps.runner.exists(bin);
    deps.log(statusLine(found, found ? `${bin}: found` : `${bin}: not found (optional)`));
  }
}

function checkGlobalInstall(options: DoctorOptions, deps: DoctorDeps, problems: string[]): void {
  printSection(deps.log, "Global install");
  let state = readGlobalPluginLink(options.home);

  if (state.target === null) {
    if (options.fix) {
      const checkoutRoot = resolveCheckoutForFix(options);
      if (checkoutRoot) {
        writeGlobalPluginLink(checkoutRoot, options.home);
        state = readGlobalPluginLink(options.home);
        deps.log(statusLine(true, `repaired: linked ${state.path} -> ${checkoutRoot}/packages/omp-plugin`));
      } else {
        report(deps, problems, `${state.path} is missing, and no checkout was found to relink it from`);
        return;
      }
    } else {
      report(deps, problems, `${state.path} is missing — run \`foreman setup\``);
      return;
    }
  }

  if (!state.resolves) {
    report(deps, problems, `${state.path} points at ${state.target}, which does not exist`);
    return;
  }
  deps.log(statusLine(true, `${state.path} -> ${state.target} (v${state.version ?? "unknown"})`));
}

function checkUserScopeInstall(options: DoctorOptions, deps: DoctorDeps, problems: string[]): void {
  printSection(deps.log, "Machine-wide install");
  const install = findUserScopeInstall(options.home);
  if (!install) {
    deps.log(statusLine(true, "none found"));
    return;
  }

  if (options.fix) {
    removeUserScopeInstall(install);
    deps.log(statusLine(true, `repaired: removed machine-wide install at ${install.root}`));
    return;
  }

  report(
    deps,
    problems,
    `${install.root} has a machine-wide Foreman install — it will fire in every repo on this machine, not just ` +
      "the ones registered with `foreman init`. Run `foreman doctor --fix` to remove it.",
  );
}

function checkCredential(options: DoctorOptions, deps: DoctorDeps, problems: string[]): void {
  printSection(deps.log, "Credential");
  const envKey = process.env.LINEAR_API_KEY;
  const config = readGlobalConfig(options.home);
  const apiKeyFile = config.apiKeyFile ? expandHome(config.apiKeyFile, options.home) : null;
  const fileConfigured = apiKeyFile !== null && existsSync(apiKeyFile);

  if (envKey) {
    deps.log(statusLine(true, "LINEAR_API_KEY set in environment"));
    return;
  }
  if (fileConfigured) {
    deps.log(statusLine(true, `linear.apiKeyFile configured (${apiKeyFile})`));
    return;
  }
  if (apiKeyFile) {
    report(deps, problems, `linear.apiKeyFile is set to ${apiKeyFile}, but that file does not exist`);
    return;
  }
  report(
    deps,
    problems,
    "no Linear credential found — set LINEAR_API_KEY or run `foreman setup` to configure linear.apiKeyFile",
  );
}

function checkRepo(options: DoctorOptions, deps: DoctorDeps, problems: string[], alias: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    report(deps, problems, `${alias}: ${path} does not exist`);
    return;
  }
  if (!existsSync(`${path}/.git`)) {
    report(deps, problems, `${alias}: ${path} has no .git — not a repo checkout`);
    return;
  }

  let state = inspectRepoActivation(path, options.home);
  if (!state.active && options.fix) {
    activateRepoPlugin(path, options.home);
    ensureGitExclude(path);
    state = inspectRepoActivation(path, options.home);
    if (state.active) {
      deps.log(statusLine(true, `${alias}: repaired, now active`));
      return;
    }
  }

  if (state.active) {
    deps.log(statusLine(true, `${alias}: active`));
    return;
  }
  for (const problemText of state.problems) report(deps, problems, `${alias}: ${problemText}`);
}

function checkRepos(options: DoctorOptions, deps: DoctorDeps, problems: string[]): void {
  printSection(deps.log, "Registered repos");
  const { config } = loadGlobalConfig({ home: options.home });
  const aliases = Object.keys(config.repos);

  if (aliases.length === 0) {
    deps.log(statusLine(true, "none registered yet — run `foreman init` in a repo to register it"));
    return;
  }

  for (const alias of aliases) {
    const entry = config.repos[alias];
    if (!entry) continue;
    checkRepo(options, deps, problems, alias, expandHome(entry.path, options.home));
  }
}

/**
 * Runs every check in order, prints a section per surface, and returns the
 * process exit code the `doctor` command should use: 0 once nothing is
 * wrong (either it started healthy, or `--fix` repaired everything), 1
 * otherwise.
 */
export async function runDoctor(options: DoctorOptions, deps: DoctorDeps): Promise<number> {
  const problems: string[] = [];

  await checkTools(options, deps, problems);
  checkGlobalInstall(options, deps, problems);
  checkUserScopeInstall(options, deps, problems);
  checkCredential(options, deps, problems);
  checkRepos(options, deps, problems);

  printSection(deps.log, "Summary");
  if (problems.length === 0) {
    deps.log(statusLine(true, options.fix ? "healthy — nothing left to fix" : "healthy"));
    return 0;
  }

  const verb = options.fix ? "still" : "found";
  deps.log(statusLine(false, `${problems.length} problem(s) ${verb}:`));
  for (const problemText of problems) deps.log(`    ${style("yellow", "-")} ${problemText}`);
  if (!options.fix) deps.log("");
  if (!options.fix) deps.log(statusLine(false, "run `foreman doctor --fix` to attempt repairs"));

  return 1;
}
