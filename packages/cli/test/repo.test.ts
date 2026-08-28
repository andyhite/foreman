import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, resolveRepoRoot } from "../src/repo.ts";

function makeFakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "foreman-repo-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "foreman" }), "utf8");
  mkdirSync(join(root, "packages", "omp-plugin"), { recursive: true });
  return root;
}

describe("findRepoRoot", () => {
  it("finds the root from a nested subdirectory", () => {
    const root = makeFakeRepo();
    try {
      const nested = join(root, "packages", "omp-plugin", "src");
      mkdirSync(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when no ancestor looks like a foreman checkout", () => {
    const stray = mkdtempSync(join(tmpdir(), "foreman-stray-"));
    try {
      expect(() => findRepoRoot(stray)).toThrow(/Could not locate the foreman repo root/);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoRoot", () => {
  it("accepts an explicit --repo path that looks like a checkout", () => {
    const root = makeFakeRepo();
    try {
      expect(resolveRepoRoot(root)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit path missing packages/omp-plugin", () => {
    const stray = mkdtempSync(join(tmpdir(), "foreman-stray-"));
    try {
      expect(() => resolveRepoRoot(stray)).toThrow(/does not look like a foreman checkout/);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });
});
