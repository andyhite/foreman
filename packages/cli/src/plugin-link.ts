/**
 * Repoints Foreman's own checkout at its working-tree copy of the omp plugin
 * (SPEC §3.1).
 *
 * `omp plugin install --scope project` writes
 * `<repo>/.omp/plugins/node_modules/@foreman/omp-plugin` as a symlink into
 * omp's marketplace cache, so a registered repo runs the *published* plugin.
 * That is what every repo Foreman manages should run, and this module does
 * not change it. The one exception is Foreman's own checkout: developing the
 * plugin against a cached copy of an older release puts a publish round-trip
 * in front of every edit.
 *
 * omp exposes no supported way to do this. `omp plugin link <dir>` and
 * installs from a local path are unconditionally user-wide regardless of
 * `--scope` — the machine-wide behavior the project-scope cutover exists to
 * prevent. But a project install is only ever a symlink, and omp resolves
 * the plugin by following it rather than by re-reading the `installPath`
 * recorded in `installed_plugins.json`, so swapping the link's target is
 * both sufficient and invisible to `omp plugin list`/`doctor` (verified
 * against omp 18.1.2).
 *
 * The marketplace metadata omp wrote is deliberately left in place: it is
 * what keeps the install project-scoped, and re-running `omp plugin install`
 * simply restores the cache target, which the next `foreman init` swaps back.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** omp's project-scope install layout, relative to the repo root. */
const LINK_SEGMENTS = [".omp", "plugins", "node_modules", "@foreman", "omp-plugin"] as const;

/** The plugin package inside a checkout, and the bundle its `omp.extensions` manifest entry points at. */
const PLUGIN_SEGMENTS = ["packages", "omp-plugin"] as const;
const BUNDLE_SEGMENTS = ["dist", "extension.js"] as const;

export interface PluginLinkResult {
  /** The symlink omp resolves the plugin through. */
  linkPath: string;
  /** Absolute path the link now points at. */
  target: string;
  /** False when the link already pointed at `target` and nothing was rewritten. */
  changed: boolean;
  /**
   * True when the checkout has no `dist/extension.js`. The Markdown half of
   * the plugin still loads; the extension half — slash commands, task and
   * skill guards, result application — does not, because that is the only
   * path `package.json`'s `omp.extensions` names.
   */
  bundleMissing: boolean;
}

/**
 * Points `repoRoot`'s project-scoped plugin link at `checkoutRoot`'s plugin
 * source. Callers are expected to have run a project install first, so the
 * surrounding `installed_plugins.json` and lock already exist; the link's
 * parent is created anyway so that ordering is not load-bearing.
 *
 * Refuses to touch a real directory: omp only ever writes a symlink here, so
 * anything else is unrecognized state that deleting could destroy.
 */
export function linkProjectPluginToCheckout(repoRoot: string, checkoutRoot: string): PluginLinkResult {
  const linkPath = join(repoRoot, ...LINK_SEGMENTS);
  const target = join(checkoutRoot, ...PLUGIN_SEGMENTS);
  const bundleMissing = !existsSync(join(target, ...BUNDLE_SEGMENTS));

  if (!existsSync(target)) {
    throw new Error(`No plugin source at ${target} — ${checkoutRoot} does not look like a foreman checkout.`);
  }

  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === target) {
      return { linkPath, target, changed: false, bundleMissing };
    }
    unlinkSync(linkPath);
  } else if (existing) {
    throw new Error(
      `${linkPath} is a real ${existing.isDirectory() ? "directory" : "file"}, not the symlink omp installs. ` +
        "Remove it by hand if it is stale, then re-run `foreman init`.",
    );
  }

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  return { linkPath, target, changed: true, bundleMissing };
}
