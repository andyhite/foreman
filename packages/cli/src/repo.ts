/**
 * Locates the Foreman checkout that a `foreman setup` invocation is running
 * from — the source of the omp-plugin and herdr-plugin directories that dev
 * mode links and that `bun run build` builds.
 *
 * Walks up from this module's own location (inside `packages/cli`) rather
 * than `process.cwd()`, so `foreman setup` works the same whether it is run
 * from the repo root, a subdirectory, or an unrelated cwd — the binary always
 * knows which checkout it shipped from.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class RepoNotFoundError extends Error {
  constructor() {
    super(
      "Could not locate the foreman repo root. `foreman setup` needs to run from " +
        "inside a clone of https://github.com/andyhite/foreman (or pass --repo <path>) " +
        "to find packages/omp-plugin and packages/herdr-plugin.",
    );
    this.name = "RepoNotFoundError";
  }
}

function looksLikeForemanRoot(dir: string): boolean {
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
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 12; hops += 1) {
    if (looksLikeForemanRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new RepoNotFoundError();
}

/** Resolves the repo root from an explicit `--repo` flag, or searches when omitted. */
export function resolveRepoRoot(explicitPath: string | null): string {
  if (explicitPath) {
    if (!looksLikeForemanRoot(explicitPath)) {
      throw new Error(`--repo ${explicitPath} does not look like a foreman checkout (no packages/omp-plugin).`);
    }
    return explicitPath;
  }
  return findRepoRoot();
}
