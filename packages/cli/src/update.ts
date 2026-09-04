/**
 * `foreman update` — pulls Foreman's source, rebuilds it, and repairs every
 * repo that follows the resulting install.
 *
 * The old version of this command had to upgrade every registered repo
 * itself, in a fixed order, because omp's plugin cache was keyed by version
 * and every project install symlinked into that shared, version-named
 * directory: upgrading one repo past a version bump could delete the
 * directory the others still pointed at. That hazard does not exist here.
 * `foreman init` now makes each repo's `.omp/plugins/node_modules/@foreman/omp-plugin`
 * a symlink to the single global `~/.foreman/plugin` link (see
 * plugin-activation.ts), and that global link in turn points at this
 * checkout's `packages/omp-plugin`. Rebuilding the checkout therefore
 * updates every repo at once, with no per-repo install step: there is
 * nothing version-keyed left to race.
 *
 * What is left to do, in order:
 *
 *  1. `git pull` the checkout, then `bun install && bun run build`. The
 *     `foreman` binary is a symlink onto `packages/cli/dist/main.js`, so a
 *     pull alone leaves the operator running the previous build.
 *  2. Re-assert the global link. Nothing here changes it under normal
 *     operation, but a moved or clobbered `~/.foreman/plugin` should
 *     self-heal on `foreman update` rather than require re-running
 *     `foreman setup`.
 *  3. Walk every registered repo and repair drift: a repo whose link or
 *     lock entry has gone stale (deleted by hand, clobbered by another
 *     tool) is re-activated; a healthy repo is left untouched and reported
 *     as such.
 *
 * Every step is best-effort and reports what it did: a machine that is half
 * updated must say so, because the failure mode this command exists to
 * prevent is a stale install that looks healthy.
 */

import { existsSync } from "node:fs";
import { activateRepoPlugin, expandHome, inspectRepoActivation, loadGlobalConfig, writeGlobalPluginLink } from "@foreman/core";
import type { Runner } from "./exec.ts";
import { printSection, style } from "./tui.ts";

export interface UpdateOptions {
  /** The Foreman checkout to pull and rebuild. */
  checkoutRoot: string;
  /** Home directory holding `.foreman/config.json`. */
  home: string;
  /** Rebuild without touching git. */
  skipPull: boolean;
  /** Leave the plugin link and registered repos alone: update the checkout only. */
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
async function pullCheckout(deps: UpdateDeps, checkoutRoot: string): Promise<boolean> {
  const inGit = await deps.runner.capture("git", ["rev-parse", "--git-dir"], { cwd: checkoutRoot });
  if (inGit.code !== 0) {
    deps.log(`  ${SKIP} not a git checkout — nothing to pull.`);
    return false;
  }

  const dirty = await deps.runner.capture("git", ["status", "--porcelain"], { cwd: checkoutRoot });
  if (dirty.stdout.trim().length > 0) {
    deps.log(`  ${WARN} uncommitted changes — skipped the pull. Commit or stash, then re-run.`);
    return false;
  }

  const upstream = await deps.runner.capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: checkoutRoot,
  });
  if (upstream.code !== 0) {
    // A detached HEAD (e.g. a `FOREMAN_REF` pin from install.sh) has no
    // upstream by design, not by drift — say so, rather than reporting a
    // silent no-op the operator has no way to distinguish from "nothing to do".
    const detached = await deps.runner.capture("git", ["symbolic-ref", "-q", "HEAD"], { cwd: checkoutRoot });
    deps.log(
      detached.code !== 0
        ? `  ${SKIP} checkout is pinned to a detached HEAD (FOREMAN_REF) — nothing to pull.`
        : `  ${SKIP} branch has no upstream — nothing to pull.`,
    );
    return false;
  }

  const before = await deps.runner.capture("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot });
  const code = await deps.runner.run("git", ["pull", "--ff-only"], { cwd: checkoutRoot });
  if (code !== 0) {
    deps.log(`  ${WARN} git pull failed (exit ${code}) — the rest of this update uses the checkout as-is.`);
    return true;
  }

  const after = await deps.runner.capture("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot });
  deps.log(
    before.stdout.trim() === after.stdout.trim()
      ? `  ${INFO} already up to date (${upstream.stdout.trim()}).`
      : `  ${OK} pulled ${upstream.stdout.trim()} → ${after.stdout.trim().slice(0, 7)}.`,
  );
  return false;
}

/** Reinstalls dependencies and rebuilds, so the installed `foreman` bin matches the source just pulled. */
async function rebuildCheckout(deps: UpdateDeps, checkoutRoot: string): Promise<boolean> {
  if (!(await deps.runner.exists("bun"))) {
    deps.log(`  ${WARN} bun not found on PATH — skipped install and build.`);
    return true;
  }

  // `--frozen-lockfile` matches `install.sh`: a post-pull lockfile drift
  // should be reported, not silently resolved to fresh dependency versions
  // on the operator's machine.
  const installCode = await deps.runner.run("bun", ["install", "--frozen-lockfile"], { cwd: checkoutRoot });
  if (installCode !== 0) {
    deps.log(`  ${WARN} bun install --frozen-lockfile failed (exit ${installCode}) — the lockfile is out of date. Skipping the build.`);
    return true;
  }

  const buildCode = await deps.runner.run("bun", ["run", "build"], { cwd: checkoutRoot });
  deps.log(
    buildCode === 0
      ? `  ${OK} rebuilt — the installed \`foreman\` now matches this checkout.`
      : `  ${WARN} bun run build failed (exit ${buildCode}) — the installed \`foreman\` is still the previous build.`,
  );
  return buildCode !== 0;
}

export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
  let failures = 0;
  printSection(deps.log, "Foreman checkout");
  deps.log(`  ${INFO} ${options.checkoutRoot}`);
  if (options.skipPull) {
    deps.log(`  ${SKIP} skipped the pull (--skip-pull).`);
  } else if (await pullCheckout(deps, options.checkoutRoot)) {
    failures += 1;
  }
  if (await rebuildCheckout(deps, options.checkoutRoot)) {
    failures += 1;
  }

  if (options.skipPlugin) {
    printSection(deps.log, "omp plugin");
    deps.log(`  ${SKIP} skipped (--skip-plugin).`);
    return failures;
  }

  printSection(deps.log, "Global plugin link");
  const globalLink = writeGlobalPluginLink(options.checkoutRoot, options.home);
  deps.log(
    globalLink.changed
      ? `  ${OK} ${globalLink.path} → ${globalLink.target}.`
      : `  ${INFO} ${globalLink.path} already points at ${globalLink.target}.`,
  );

  printSection(deps.log, "Registered repos");
  const { config } = loadGlobalConfig({ home: options.home });
  const aliases = Object.keys(config.repos).sort();
  if (aliases.length === 0) {
    deps.log(`  ${SKIP} none registered — run \`foreman init\` in a repo first.`);
    return failures;
  }

  for (const alias of aliases) {
    const repoPath = expandHome(config.repos[alias]!.path, options.home);
    if (!existsSync(repoPath)) {
      deps.log(`  ${WARN} ${alias} — ${repoPath} no longer exists.`);
      failures += 1;
      continue;
    }

    try {
      const state = inspectRepoActivation(repoPath, options.home);
      if (state.active) {
        deps.log(`  ${OK} ${alias} — already active.`);
        continue;
      }
      const result = activateRepoPlugin(repoPath, options.home);
      deps.log(
        `  ${OK} ${alias} — repaired (${[
          result.linkChanged ? "relinked" : null,
          result.lockChanged ? "lock rewritten" : null,
        ]
          .filter((entry): entry is string => entry !== null)
          .join(", ") || "already matched"}).`,
      );
    } catch (error) {
      deps.log(`  ${WARN} ${alias} — ${(error as Error).message}`);
      failures += 1;
    }
  }
  return failures;
}
