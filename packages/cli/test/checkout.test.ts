import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findCheckoutRoot, resolveCheckoutRoot } from "../src/checkout.ts";

function makeFakeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "foreman-checkout-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "foreman" }), "utf8");
  mkdirSync(join(root, "packages", "omp-plugin"), { recursive: true });
  return root;
}

describe("findCheckoutRoot", () => {
  it("finds the root from a nested subdirectory", () => {
    const root = makeFakeCheckout();
    try {
      const nested = join(root, "packages", "omp-plugin", "src");
      mkdirSync(nested, { recursive: true });
      expect(findCheckoutRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when no ancestor looks like a foreman checkout", () => {
    const stray = mkdtempSync(join(tmpdir(), "foreman-stray-"));
    try {
      expect(() => findCheckoutRoot(stray)).toThrow(/Could not locate the foreman checkout/);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("resolveCheckoutRoot", () => {
  it("accepts an explicit --checkout path that looks like a checkout", () => {
    const root = makeFakeCheckout();
    try {
      expect(resolveCheckoutRoot(root)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit path missing packages/omp-plugin", () => {
    const stray = mkdtempSync(join(tmpdir(), "foreman-stray-"));
    try {
      expect(() => resolveCheckoutRoot(stray)).toThrow(/does not look like a foreman checkout/);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it("resolves a relative --checkout path to an absolute one", () => {
    const root = makeFakeCheckout();
    const originalCwd = process.cwd();
    try {
      process.chdir(dirname(root));
      const resolved = resolveCheckoutRoot(`./${basename(root)}`);
      expect(resolved).toBe(realpathSync(root));
      expect(resolved).toMatch(/^\//);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
