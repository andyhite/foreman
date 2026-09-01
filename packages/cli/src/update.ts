/**
 * `foreman update` — pulls Foreman's source and re-syncs every install it
 * owns (SPEC §3.1).
 *
 * Exists because keeping a machine current is not one command but four, in a
 * fixed order, and getting the order wrong fails silently:
 *
 *  1. `git pull` the checkout, then `bun install && bun run build`. The
 *     `foreman` binary is a symlink onto `packages/cli/dist/main.js`, so a
 *     pull alone leaves the operator running the previous build.
 *  2. `omp plugin marketplace update`. omp's `upgrade` re-copies whatever
 *     the local marketplace clone already holds and never fetches, so
 *     skipping this makes every later upgrade a confident no-op onto stale
 *     content.
 *  3. `omp plugin upgrade` in *every* registered repo. The plugin cache is
 *     keyed by version (`foreman___foreman___0.1.0`) and all project
 *     installs symlink into the same directory, so upgrading one repo past
 *     a version bump deletes the directory the others still point at and
 *     leaves them dangling. Partial coverage is worse than none.
 *  4. Re-link Foreman's own checkout. Step 3 run there replaces the dev
 *     link with a cache link, undoing `foreman init` (see plugin-link.ts).
 *
 * Every step is best-effort and reports what it did: a machine that is half
 * updated must say so, because the failure mode this command exists to
 * prevent is a stale install that looks healthy.
 */

import { existsSync } from "node:fs";
import { expandHome, loadGlobalConfig } from "@foreman/core";
import type { Runner } from "./exec.ts";
import {
  DEFAULT_OMP_PLUGIN_NAME,
  FOREMAN_MARKETPLACE_NAME,
  findPluginScopes,
  ompMarketplaceUpdateArgv,
  ompPluginListArgv,
  ompUpgradeArgv,
} from "./plugin-commands.ts";
import { linkProjectPluginToCheckout } from "./plugin-link.ts";
import { printSection, style } from "./tui.ts";

export interface UpdateOptions {
  /** The Foreman checkout to pull and rebuild. */
  checkoutRoot: string;
  /** Home directory holding `.foreman/config.json`. */
  home: string;
  /** Rebuild without touching git. */
  skipPull: boolean;
  /** Leave omp alone: update the checkout only. */
  skipPlugin: boolean;
}

export interface UpdateDeps {
  runner: Runner;
  log: (message: string) => void;
}

const OK = style("green", "✓");
const INFO = style("cyan", "i");
const WARN = style("yellow", "!");
const SKIP = style("dim", "○");

/**
 * Fast-forwards the checkout. Refuses on a dirty tree rather than stashing:
 * this runs on the machine someone develops Foreman on, and silently moving
 * their work is a worse outcome than an un-updated checkout.
 */
async function pullCheckout(deps: UpdateDeps, checkoutRoot: string): Promise<void> {
  const inGit = await deps.runner.capture("git", ["rev-parse", "--git-dir"], { cwd: checkoutRoot });
  if (inGit.code !== 0) {
    deps.log(`  ${SKIP} not a git checkout — nothing to pull.`);
    return;
  }

  const dirty = await deps.runner.capture("git", ["status", "--porcelain"], { cwd: checkoutRoot });
  if (dirty.stdout.trim().length > 0) {
    deps.log(`  ${WARN} uncommitted changes — skipped the pull. Commit or stash, then re-run.`);
    return;
  }

  const upstream = await deps.runner.capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: checkoutRoot,
  });
  if (upstream.code !== 0) {
    deps.log(`  ${SKIP} branch has no upstream — nothing to pull.`);
    return;
  }

  const before = await deps.runner.capture("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot });
  const code = await deps.runner.run("git", ["pull", "--ff-only"], { cwd: checkoutRoot });
  if (code !== 0) {
    deps.log(`  ${WARN} git pull failed (exit ${code}) — the rest of this update uses the checkout as-is.`);
    return;
  }

  const after = await deps.runner.capture("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot });
  deps.log(
    before.stdout.trim() === after.stdout.trim()
      ? `  ${INFO} already up to date (${upstream.stdout.trim()}).`
      : `  ${OK} pulled ${upstream.stdout.trim()} → ${after.stdout.trim().slice(0, 7)}.`,
  );
}

/** Reinstalls dependencies and rebuilds, so the installed `foreman` bin matches the source just pulled. */
async function rebuildCheckout(deps: UpdateDeps, checkoutRoot: string): Promise<void> {
  if (!(await deps.runner.exists("bun"))) {
    deps.log(`  ${WARN} bun not found on PATH — skipped install and build.`);
    return;
  }

  const installCode = await deps.runner.run("bun", ["install"], { cwd: checkoutRoot });
  if (installCode !== 0) {
    deps.log(`  ${WARN} bun install failed (exit ${installCode}) — skipping the build.`);
    return;
  }

  const buildCode = await deps.runner.run("bun", ["run", "build"], { cwd: checkoutRoot });
  deps.log(
    buildCode === 0
      ? `  ${OK} rebuilt — the installed \`foreman\` now matches this checkout.`
      : `  ${WARN} bun run build failed (exit ${buildCode}) — the installed \`foreman\` is still the previous build.`,
  );
}

/**
 * Upgrades one repo's project install. Probes first because omp reports
 * "not installed" on stdout and still exits 0, so the exit code alone cannot
 * tell an upgrade from a no-op.
 */
async function upgradeRepo(deps: UpdateDeps, alias: string, repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) {
    deps.log(`  ${SKIP} ${alias} — ${repoPath} no longer exists.`);
    return false;
  }

  const listed = await deps.runner.capture("omp", ompPluginListArgv(), { cwd: repoPath });
  const scopes =
    listed.code === 0
      ? findPluginScopes(listed.stdout, DEFAULT_OMP_PLUGIN_NAME, FOREMAN_MARKETPLACE_NAME)
      : { project: false, user: false };
  if (!scopes.project) {
    deps.log(`  ${SKIP} ${alias} — no project install; run \`foreman init\` there.`);
    return false;
  }

  const upgrade = await deps.runner.capture("omp", ompUpgradeArgv(DEFAULT_OMP_PLUGIN_NAME), { cwd: repoPath });
  const output = `${upgrade.stdout}${upgrade.stderr}`.trim();
  if (upgrade.code !== 0 || /fail/i.test(output)) {
    deps.log(`  ${WARN} ${alias} — upgrade failed: ${output.split("\n")[0] ?? `exit ${upgrade.code}`}`);
    return false;
  }
  deps.log(`  ${OK} ${alias} — ${output.split("\n")[0] ?? "upgraded"}`);
  return true;
}

export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<void> {
  printSection(deps.log, "Foreman checkout");
  deps.log(`  ${INFO} ${options.checkoutRoot}`);
  if (options.skipPull) {
    deps.log(`  ${SKIP} skipped the pull (--skip-pull).`);
  } else {
    await pullCheckout(deps, options.checkoutRoot);
  }
  await rebuildCheckout(deps, options.checkoutRoot);

  if (options.skipPlugin) {
    printSection(deps.log, "omp plugin");
    deps.log(`  ${SKIP} skipped (--skip-plugin).`);
    return;
  }

  printSection(deps.log, "omp marketplace");
  if (!(await deps.runner.exists("omp"))) {
    deps.log(`  ${WARN} omp not found on PATH — skipped the plugin refresh entirely.`);
    return;
  }
  const marketplaceCode = await deps.runner.run("omp", ompMarketplaceUpdateArgv());
  if (marketplaceCode !== 0) {
    deps.log(
      `  ${WARN} marketplace update failed (exit ${marketplaceCode}) — skipping repo upgrades, ` +
        "which would otherwise reinstall the same stale content.",
    );
    return;
  }
  deps.log(`  ${OK} refreshed "${FOREMAN_MARKETPLACE_NAME}" from GitHub.`);

  printSection(deps.log, "Registered repos");
  const { config } = loadGlobalConfig({ home: options.home });
  const aliases = Object.keys(config.repos).sort();
  if (aliases.length === 0) {
    deps.log(`  ${SKIP} none registered — run \`foreman init\` in a repo first.`);
    return;
  }

  /*
   * Serial, not concurrent: every upgrade writes the same version-keyed
   * cache directory, and omp offers no locking around it.
   */
  for (const alias of aliases) {
    const repoPath = expandHome(config.repos[alias]!.path, options.home);
    await upgradeRepo(deps, alias, repoPath);
  }

  const checkoutAlias = aliases.find((alias) => expandHome(config.repos[alias]!.path, options.home) === options.checkoutRoot);
  if (checkoutAlias === undefined) return;

  const link = linkProjectPluginToCheckout(options.checkoutRoot, options.checkoutRoot);
  deps.log(
    link.changed
      ? `  ${OK} ${checkoutAlias} — re-linked to this checkout's working tree (dev mode).`
      : `  ${INFO} ${checkoutAlias} — still linked to this checkout's working tree (dev mode).`,
  );
  if (link.bundleMissing) {
    deps.log(`  ${WARN} packages/omp-plugin/dist/extension.js is missing — run \`bun run build\`.`);
  }
}
