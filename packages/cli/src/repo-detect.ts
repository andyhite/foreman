/**
 * Heuristics for suggesting a local repo path when mapping a Linear project
 * during `foreman setup` (SPEC §3.10). The operator still confirms or edits
 * every suggestion — `guessRepoPath` only saves typing the common case where
 * the project already has a checkout under a directory like `~/Code`.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Lowercases and strips everything but letters/digits, so "My App!" and "my-app" compare equal. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Bigram Dice coefficient — close enough to rank "plotroom" against "PlotRoom UI" without a dependency. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigramCounts.set(gram, (bigramCounts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const remaining = bigramCounts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      bigramCounts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** A project name is confidently the same repo above this score; below it, guessing is worse than asking. */
const MATCH_THRESHOLD = 0.6;

/** Directories to search for an existing checkout, in priority order; only existing ones are scanned. */
function searchRoots(repoRoot: string): string[] {
  const home = homedir();
  const candidates = [
    dirname(repoRoot),
    join(home, "Code"),
    join(home, "code"),
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "dev"),
    join(home, "Developer"),
    join(home, "src"),
    join(home, "Documents", "Code"),
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate) || !existsSync(candidate)) continue;
    seen.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

/**
 * Finds the best-matching git checkout for a Linear project name among
 * common code directories (a sibling of this checkout, `~/Code`, `~/dev`,
 * etc). Returns null below `MATCH_THRESHOLD` rather than guess — a wrong
 * path silently pointed at the wrong repo is worse than an empty prompt.
 */
export function guessRepoPath(projectName: string, repoRoot: string): string | null {
  const target = normalize(projectName);
  if (target.length === 0) return null;

  let best: { path: string; score: number } | null = null;
  for (const root of searchRoots(repoRoot)) {
    let entryNames: string[];
    try {
      entryNames = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entryName of entryNames) {
      const candidatePath = join(root, entryName);
      if (!existsSync(join(candidatePath, ".git"))) continue;
      const score = similarity(target, normalize(entryName));
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { path: candidatePath, score };
    }
  }
  return best?.path ?? null;
}
