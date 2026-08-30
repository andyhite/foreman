/**
 * Writes the `foreman` executable that dev mode uses in place of the built
 * `dist/main.js` bundle the one-line installer (`scripts/install.sh`) drops
 * on `$PATH`: a wrapper script that always execs *this checkout's source*
 * through `bun`. Bun runs TypeScript directly, so — like `omp plugin
 * link`'s symlink into `packages/omp-plugin` — a source edit here needs no
 * rebuild to take effect; only `omp plugin install` and the one-line
 * installer's wrapper use the built artifact.
 *
 * Mirrors `scripts/install.sh`'s own wrapper-generation shape (same
 * `$FOREMAN_BIN_DIR` env override, same 0755 shell shim) so both paths
 * install `foreman` the same way, just pointed at different targets.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `$FOREMAN_BIN_DIR`, or `<home>/.local/bin` — the same default `scripts/install.sh` uses. */
export function cliBinDir(home: string): string {
  return process.env.FOREMAN_BIN_DIR ?? join(home, ".local", "bin");
}

/** Writes the wrapper and returns its path. */
export function writeCliBinLink(repoRoot: string, home: string): string {
  const dir = cliBinDir(home);
  const binPath = join(dir, "foreman");
  const entry = join(repoRoot, "packages", "cli", "src", "main.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(binPath, `#!/usr/bin/env bash\nexec bun "${entry}" "$@"\n`, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}
