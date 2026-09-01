/**
 * Locates the Foreman checkout that a `foreman setup` invocation is running
 * from — the source of the omp-plugin directory that dev mode links and that
 * `bun run build` builds.
 *
 * Named for the checkout, not the repo: "repo" already means two other things
 * in this CLI — the `foreman repo` supervisor command, and a `repos` registry
 * alias naming a product repo Foreman manages (SPEC §3.10, §3.11). This
 * module resolves neither; it finds Foreman's own source tree.
 *
 * Walks up from this module's own location (inside `packages/cli`) rather
 * than `process.cwd()`, so `foreman setup` works the same whether it is run
 * from the repo root, a subdirectory, or an unrelated cwd — the binary always
 * knows which checkout it shipped from.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class CheckoutNotFoundError extends Error {
  constructor() {
    super(
      "Could not locate the foreman checkout. `foreman setup` needs to run from " +
        "inside a clone of https://github.com/andyhite/foreman (or pass --checkout <path>) " +
        "to find packages/omp-plugin.",
    );
    this.name = "CheckoutNotFoundError";
  }
}

/** True when `dir` is a Foreman checkout: the monorepo root that owns `packages/omp-plugin`. */
export function looksLikeForemanRoot(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === "foreman" && existsSync(join(dir, "packages", "omp-plugin"));
  } catch {
    return false;
  }
}

/** Searches `startDir` and its ancestors (default: this module's own location). */
export function findCheckoutRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 12; hops += 1) {
    if (looksLikeForemanRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CheckoutNotFoundError();
}

/** Resolves the checkout root from an explicit `--checkout` flag, or searches when omitted. */
export function resolveCheckoutRoot(explicitPath: string | null): string {
  if (explicitPath) {
    if (!looksLikeForemanRoot(explicitPath)) {
      throw new Error(`--checkout ${explicitPath} does not look like a foreman checkout (no packages/omp-plugin).`);
    }
    return explicitPath;
  }
  return findCheckoutRoot();
}
