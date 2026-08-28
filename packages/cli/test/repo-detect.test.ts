import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guessRepoPath } from "../src/repo-detect.ts";

describe("guessRepoPath", () => {
  it("finds a sibling git checkout whose name matches the project name", () => {
    const base = mkdtempSync(join(tmpdir(), "foreman-repo-detect-"));
    try {
      mkdirSync(join(base, "plot-room", ".git"), { recursive: true });
      mkdirSync(join(base, "unrelated-thing", ".git"), { recursive: true });

      const repoRoot = join(base, "foreman-checkout");
      mkdirSync(repoRoot, { recursive: true });

      expect(guessRepoPath("Plot Room", repoRoot)).toBe(join(base, "plot-room"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null when nothing scores above the match threshold", () => {
    const base = mkdtempSync(join(tmpdir(), "foreman-repo-detect-"));
    try {
      mkdirSync(join(base, "totally-different-name", ".git"), { recursive: true });
      const repoRoot = join(base, "foreman-checkout");
      mkdirSync(repoRoot, { recursive: true });

      expect(guessRepoPath("Zephyr Widgets", repoRoot)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("ignores directories that aren't git checkouts", () => {
    const base = mkdtempSync(join(tmpdir(), "foreman-repo-detect-"));
    try {
      mkdirSync(join(base, "plot-room"), { recursive: true });
      const repoRoot = join(base, "foreman-checkout");
      mkdirSync(repoRoot, { recursive: true });

      expect(guessRepoPath("Plot Room", repoRoot)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
