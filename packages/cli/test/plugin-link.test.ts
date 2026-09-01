import { describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkProjectPluginToCheckout } from "../src/plugin-link.ts";

const LINK_SEGMENTS = [".omp", "plugins", "node_modules", "@foreman", "omp-plugin"];

/** A checkout with a plugin package; `withBundle` mirrors having run `bun run build`. */
function makeCheckout(withBundle: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "foreman-link-"));
  const plugin = join(root, "packages", "omp-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "@foreman/omp-plugin" }), "utf8");
  if (withBundle) {
    mkdirSync(join(plugin, "dist"), { recursive: true });
    writeFileSync(join(plugin, "dist", "extension.js"), "export default {};\n", "utf8");
  }
  return root;
}

/** The symlink-into-the-marketplace-cache that `omp plugin install --scope project` leaves behind. */
function installCacheLink(repoRoot: string): string {
  const linkPath = join(repoRoot, ...LINK_SEGMENTS);
  const cache = mkdtempSync(join(tmpdir(), "foreman-cache-"));
  mkdirSync(join(repoRoot, ".omp", "plugins", "node_modules", "@foreman"), { recursive: true });
  symlinkSync(cache, linkPath);
  return cache;
}

describe("linkProjectPluginToCheckout", () => {
  it("repoints an existing cache install at the working tree", () => {
    const root = makeCheckout(true);
    try {
      const cache = installCacheLink(root);
      const result = linkProjectPluginToCheckout(root, root);

      expect(result.changed).toBe(true);
      expect(result.target).toBe(join(root, "packages", "omp-plugin"));
      expect(readlinkSync(result.linkPath)).toBe(result.target);
      expect(readlinkSync(result.linkPath)).not.toBe(cache);
      rmSync(cache, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the link when no install has run yet", () => {
    const root = makeCheckout(true);
    try {
      const result = linkProjectPluginToCheckout(root, root);

      expect(result.changed).toBe(true);
      expect(lstatSync(result.linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(result.linkPath)).toBe(join(root, "packages", "omp-plugin"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second run reports no change", () => {
    const root = makeCheckout(true);
    try {
      linkProjectPluginToCheckout(root, root);
      const second = linkProjectPluginToCheckout(root, root);

      expect(second.changed).toBe(false);
      expect(readlinkSync(second.linkPath)).toBe(second.target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing bundle, since the extension half won't load without it", () => {
    const built = makeCheckout(true);
    const unbuilt = makeCheckout(false);
    try {
      expect(linkProjectPluginToCheckout(built, built).bundleMissing).toBe(false);
      expect(linkProjectPluginToCheckout(unbuilt, unbuilt).bundleMissing).toBe(true);
    } finally {
      rmSync(built, { recursive: true, force: true });
      rmSync(unbuilt, { recursive: true, force: true });
    }
  });

  it("refuses to delete a real directory left where the symlink belongs", () => {
    const root = makeCheckout(true);
    try {
      const linkPath = join(root, ...LINK_SEGMENTS);
      mkdirSync(linkPath, { recursive: true });
      writeFileSync(join(linkPath, "keep.txt"), "not omp's", "utf8");

      expect(() => linkProjectPluginToCheckout(root, root)).toThrow(/is a real directory/);
      expect(lstatSync(join(linkPath, "keep.txt")).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a checkout with no plugin source", () => {
    const root = mkdtempSync(join(tmpdir(), "foreman-bare-"));
    try {
      expect(() => linkProjectPluginToCheckout(root, root)).toThrow(/does not look like a foreman checkout/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
