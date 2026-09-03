/**
 * Covers `plugin-activation.ts`'s on-disk contract directly: every function
 * here reads or writes real files under temp `home`/`repo`/`checkout` roots,
 * because the whole point of the module is filesystem shape omp discovers —
 * there is nothing meaningful to fake around it.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateRepoPlugin,
  checkoutPluginDir,
  deactivateRepoPlugin,
  ensureGitExclude,
  findUserScopeInstall,
  globalPluginLinkPath,
  inspectRepoActivation,
  readGlobalPluginLink,
  removeUserScopeInstall,
  repoPluginLinkPath,
  repoPluginLockPath,
  repoPluginRoot,
  writeGlobalPluginLink,
} from "../src/plugin-activation.ts";

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `foreman-${prefix}-`));
}

/** A checkout with a real `packages/omp-plugin` package, version 1.2.3. */
function makeCheckout(): string {
  const root = makeTmp("checkout");
  const pluginDir = join(root, "packages", "omp-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "@foreman/omp-plugin", version: "1.2.3", omp: { extensions: ["./src/extension.ts"] } }),
    "utf8",
  );
  return root;
}

function makeRepo(): string {
  const root = makeTmp("repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

describe("writeGlobalPluginLink", () => {
  it("creates the global link pointing at the checkout's plugin package", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    try {
      const result = writeGlobalPluginLink(checkout, home);
      expect(result.path).toBe(globalPluginLinkPath(home));
      expect(result.target).toBe(checkoutPluginDir(checkout));
      expect(result.changed).toBe(true);
      expect(lstatSync(result.path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(result.path)).toBe(checkoutPluginDir(checkout));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("reports unchanged on a re-run that already points at the target", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    try {
      writeGlobalPluginLink(checkout, home);
      const second = writeGlobalPluginLink(checkout, home);
      expect(second.changed).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("throws when the checkout has no plugin package", () => {
    const home = makeTmp("home");
    const stray = makeTmp("stray");
    try {
      expect(() => writeGlobalPluginLink(stray, home)).toThrow(/No plugin package at/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it("throws rather than deleting a real file at the link path", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    try {
      const path = globalPluginLinkPath(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "not a symlink", "utf8");
      expect(() => writeGlobalPluginLink(checkout, home)).toThrow(/real file/);
      expect(readFileSync(path, "utf8")).toBe("not a symlink");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("throws rather than deleting a real directory at the link path", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    try {
      const path = globalPluginLinkPath(home);
      mkdirSync(path, { recursive: true });
      expect(() => writeGlobalPluginLink(checkout, home)).toThrow(/real directory/);
      expect(lstatSync(path).isDirectory()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe("readGlobalPluginLink", () => {
  it("reports absent when there is no link", () => {
    const home = makeTmp("home");
    try {
      const state = readGlobalPluginLink(home);
      expect(state.target).toBeNull();
      expect(state.resolves).toBe(false);
      expect(state.version).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a healthy link's resolution and version", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    try {
      writeGlobalPluginLink(checkout, home);
      const state = readGlobalPluginLink(home);
      expect(state.resolves).toBe(true);
      expect(state.version).toBe("1.2.3");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("reports a dangling link's target without resolving", () => {
    const home = makeTmp("home");
    try {
      const path = globalPluginLinkPath(home);
      mkdirSync(dirname(path), { recursive: true });
      const missingTarget = join(home, "nowhere");
      symlinkSync(missingTarget, path);
      const state = readGlobalPluginLink(home);
      expect(state.target).toBe(missingTarget);
      expect(state.resolves).toBe(false);
      expect(state.version).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("activateRepoPlugin", () => {
  it("links the repo to the global link path and writes a lock entry", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const result = activateRepoPlugin(repo, home);
      expect(result.target).toBe(globalPluginLinkPath(home));
      expect(readlinkSync(result.linkPath)).toBe(globalPluginLinkPath(home));
      expect(result.linkChanged).toBe(true);
      expect(result.lockChanged).toBe(true);
      expect(result.version).toBe("1.2.3");

      const lock = JSON.parse(readFileSync(result.lockPath, "utf8"));
      expect(lock.plugins["@foreman/omp-plugin"]).toEqual({
        version: "1.2.3",
        enabledFeatures: null,
        enabled: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is idempotent: a re-run changes neither the link nor the lock", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      const second = activateRepoPlugin(repo, home);
      expect(second.linkChanged).toBe(false);
      expect(second.lockChanged).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("merges into an existing lock, preserving another plugin's entry and settings", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const lockPath = repoPluginLockPath(repo);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          plugins: { "@other/plugin": { version: "0.1.0", enabledFeatures: null, enabled: true } },
          settings: { "@other/plugin": { some: "setting" } },
        }),
        "utf8",
      );
      activateRepoPlugin(repo, home);
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(lock.plugins["@other/plugin"]).toEqual({ version: "0.1.0", enabledFeatures: null, enabled: true });
      expect(lock.settings["@other/plugin"]).toEqual({ some: "setting" });
      expect(lock.plugins["@foreman/omp-plugin"]).toEqual({
        version: "1.2.3",
        enabledFeatures: null,
        enabled: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws when the global link is absent", () => {
    const home = makeTmp("home");
    const repo = makeRepo();
    try {
      expect(() => activateRepoPlugin(repo, home)).toThrow(/foreman setup/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws when the repo link path is a real directory", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(linkPath, { recursive: true });
      expect(() => activateRepoPlugin(repo, home)).toThrow(/real directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("repairs a symlink that points somewhere else", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "elsewhere"), linkPath);
      const result = activateRepoPlugin(repo, home);
      expect(result.linkChanged).toBe(true);
      expect(readlinkSync(linkPath)).toBe(globalPluginLinkPath(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws rather than overwriting an existing lock that is invalid JSON", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const lockPath = repoPluginLockPath(repo);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "{ not json", "utf8");
      expect(() => activateRepoPlugin(repo, home)).toThrow(new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(readFileSync(lockPath, "utf8")).toBe("{ not json");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws rather than overwriting an existing lock that is a JSON array", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const lockPath = repoPluginLockPath(repo);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "[]", "utf8");
      expect(() => activateRepoPlugin(repo, home)).toThrow(new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws rather than overwriting an existing lock that is a JSON scalar", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const lockPath = repoPluginLockPath(repo);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "42", "utf8");
      expect(() => activateRepoPlugin(repo, home)).toThrow(new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("also writes installed_plugins.json so commands namespace under \"foreman:\"", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const result = activateRepoPlugin(repo, home);
      expect(result.installedPluginsChanged).toBe(true);

      const registry = JSON.parse(readFileSync(result.installedPluginsPath, "utf8"));
      expect(registry.version).toBe(1);
      expect(registry.plugins["foreman@foreman"]).toHaveLength(1);
      const entry = registry.plugins["foreman@foreman"][0];
      expect(entry.installPath).toBe(result.linkPath);
      expect(entry.version).toBe("1.2.3");
      expect(entry.enabled).toBe(true);
      expect(entry.scope).toBe("project");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is idempotent for installed_plugins.json too: a re-run changes nothing", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const first = activateRepoPlugin(repo, home);
      const before = readFileSync(first.installedPluginsPath, "utf8");
      const second = activateRepoPlugin(repo, home);
      expect(second.installedPluginsChanged).toBe(false);
      expect(readFileSync(first.installedPluginsPath, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("merges into an existing installed_plugins.json, preserving another plugin's entries", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const registryPath = join(repoPluginRoot(repo), "installed_plugins.json");
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: {
            "other@marketplace": [
              { installPath: "/somewhere/else", version: "0.1.0", installedAt: "x", lastUpdated: "x", enabled: true, scope: "project" },
            ],
          },
        }),
        "utf8",
      );
      activateRepoPlugin(repo, home);
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      expect(registry.plugins["other@marketplace"]).toHaveLength(1);
      expect(registry.plugins["foreman@foreman"]).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("inspectRepoActivation", () => {
  it("reports active for a healthy repo", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(true);
      expect(state.problems).toEqual([]);
      expect(state.linkHealthy).toBe(true);
      expect(state.lockEntryPresent).toBe(true);
      expect(state.lockEntryEnabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the link missing", () => {
    const home = makeTmp("home");
    const repo = makeRepo();
    try {
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.linkHealthy).toBe(false);
      expect(state.linkTarget).toBeNull();
      expect(state.problems.length).toBeGreaterThan(0);
      expect(state.problems.some((p) => p.includes("is missing"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the link pointing elsewhere", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "elsewhere"), linkPath);
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.linkHealthy).toBe(false);
      expect(state.linkTarget).toBe(join(home, "elsewhere"));
      expect(state.problems.some((p) => p.includes("points at"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a dangling link that points at the expected target", () => {
    const home = makeTmp("home");
    const repo = makeRepo();
    try {
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(globalPluginLinkPath(home), linkPath);
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.linkHealthy).toBe(false);
      expect(state.linkTarget).toBe(globalPluginLinkPath(home));
      expect(state.problems.some((p) => p.includes("does not resolve"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the lock entry absent", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(globalPluginLinkPath(home), linkPath);
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.linkHealthy).toBe(true);
      expect(state.lockEntryPresent).toBe(false);
      expect(state.problems.some((p) => p.includes("no"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the lock entry disabled", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      const lockPath = repoPluginLockPath(repo);
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.plugins["@foreman/omp-plugin"].enabled = false;
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.lockEntryPresent).toBe(true);
      expect(state.lockEntryEnabled).toBe(false);
      expect(state.problems.some((p) => p.includes("disabled"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("reports the installed_plugins.json entry absent", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const linkPath = repoPluginLinkPath(repo);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(globalPluginLinkPath(home), linkPath);
      const lockPath = repoPluginLockPath(repo);
      writeFileSync(
        lockPath,
        JSON.stringify({ plugins: { "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true } }, settings: {} }),
        "utf8",
      );
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.linkHealthy).toBe(true);
      expect(state.lockEntryEnabled).toBe(true);
      expect(state.installedPluginsEntryPresent).toBe(false);
      expect(state.problems.some((p) => p.includes("foreman:"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the installed_plugins.json entry disabled", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const result = activateRepoPlugin(repo, home);
      const registry = JSON.parse(readFileSync(result.installedPluginsPath, "utf8"));
      registry.plugins["foreman@foreman"][0].enabled = false;
      writeFileSync(result.installedPluginsPath, JSON.stringify(registry), "utf8");
      const state = inspectRepoActivation(repo, home);
      expect(state.active).toBe(false);
      expect(state.installedPluginsEntryPresent).toBe(true);
      expect(state.installedPluginsEntryEnabled).toBe(false);
      expect(state.problems.some((p) => p.includes("disabled"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("deactivateRepoPlugin", () => {
  it("removes the symlink and lock, and prunes empty .omp/plugins and .omp", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      const result = deactivateRepoPlugin(repo);
      expect(result.linkRemoved).toBe(true);
      expect(result.lockEntryRemoved).toBe(true);
      expect(result.lockRemoved).toBe(true);
      expect(existsSync(repoPluginLinkPath(repo))).toBe(false);
      expect(existsSync(repoPluginLockPath(repo))).toBe(false);
      expect(existsSync(join(repo, ".omp"))).toBe(false);
      expect(result.prunedDirs).toContain(join(repo, ".omp"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the lock file and another plugin's entry", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      const lockPath = repoPluginLockPath(repo);
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.plugins["@other/plugin"] = { version: "0.1.0", enabledFeatures: null, enabled: true };
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");

      const result = deactivateRepoPlugin(repo);
      expect(result.lockEntryRemoved).toBe(true);
      expect(result.lockRemoved).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      const after = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(after.plugins["@foreman/omp-plugin"]).toBeUndefined();
      expect(after.plugins["@other/plugin"]).toEqual({ version: "0.1.0", enabledFeatures: null, enabled: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves .omp/ alone when it still holds other content", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      activateRepoPlugin(repo, home);
      writeFileSync(join(repo, ".omp", "config.yml"), "some: config\n", "utf8");
      const result = deactivateRepoPlugin(repo);
      expect(result.linkRemoved).toBe(true);
      expect(existsSync(join(repo, ".omp"))).toBe(true);
      expect(existsSync(join(repo, ".omp", "config.yml"))).toBe(true);
      expect(result.prunedDirs).not.toContain(join(repo, ".omp"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is a safe no-op on a repo that was never activated", () => {
    const repo = makeRepo();
    try {
      const result = deactivateRepoPlugin(repo);
      expect(result.linkRemoved).toBe(false);
      expect(result.lockEntryRemoved).toBe(false);
      expect(result.lockRemoved).toBe(false);
      expect(result.prunedDirs).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it("also removes the installed_plugins.json entry and file", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const activation = activateRepoPlugin(repo, home);
      const result = deactivateRepoPlugin(repo);
      expect(result.installedPluginsEntryRemoved).toBe(true);
      expect(result.installedPluginsRemoved).toBe(true);
      expect(existsSync(activation.installedPluginsPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps installed_plugins.json and another plugin's entry", () => {
    const home = makeTmp("home");
    const checkout = makeCheckout();
    const repo = makeRepo();
    try {
      writeGlobalPluginLink(checkout, home);
      const activation = activateRepoPlugin(repo, home);
      const registry = JSON.parse(readFileSync(activation.installedPluginsPath, "utf8"));
      registry.plugins["other@marketplace"] = [
        { installPath: "/somewhere/else", version: "0.1.0", installedAt: "x", lastUpdated: "x", enabled: true, scope: "project" },
      ];
      writeFileSync(activation.installedPluginsPath, JSON.stringify(registry), "utf8");

      const result = deactivateRepoPlugin(repo);
      expect(result.installedPluginsEntryRemoved).toBe(true);
      expect(result.installedPluginsRemoved).toBe(false);
      expect(existsSync(activation.installedPluginsPath)).toBe(true);
      const after = JSON.parse(readFileSync(activation.installedPluginsPath, "utf8"));
      expect(after.plugins["foreman@foreman"]).toBeUndefined();
      expect(after.plugins["other@marketplace"]).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("ensureGitExclude", () => {
  it("creates info/exclude with the ignore line", () => {
    const repo = makeRepo();
    try {
      const result = ensureGitExclude(repo);
      expect(result).not.toBeNull();
      expect(result?.changed).toBe(true);
      const contents = readFileSync(result!.path, "utf8");
      expect(contents).toContain("/.omp/plugins/");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports unchanged on a re-run", () => {
    const repo = makeRepo();
    try {
      ensureGitExclude(repo);
      const second = ensureGitExclude(repo);
      expect(second?.changed).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("appends without clobbering existing content, even lacking a trailing newline", () => {
    const repo = makeRepo();
    try {
      const excludePath = join(repo, ".git", "info", "exclude");
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, "/some-other-ignore", "utf8");
      const result = ensureGitExclude(repo);
      expect(result?.changed).toBe(true);
      const contents = readFileSync(excludePath, "utf8");
      expect(contents).toContain("/some-other-ignore");
      expect(contents).toContain("/.omp/plugins/");
      // The prior line survives intact rather than being merged into a new one.
      expect(contents.split("\n")[0]).toBe("/some-other-ignore");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("follows a gitdir: pointer file for a linked worktree", () => {
    const repo = makeTmp("worktree");
    const realGitDir = makeTmp("gitdir");
    try {
      writeFileSync(join(repo, ".git"), `gitdir: ${realGitDir}\n`, "utf8");
      const result = ensureGitExclude(repo);
      expect(result).not.toBeNull();
      expect(result?.path).toBe(join(realGitDir, "info", "exclude"));
      expect(existsSync(result!.path)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(realGitDir, { recursive: true, force: true });
    }
  });

  it("returns null when there is no .git", () => {
    const stray = makeTmp("stray");
    try {
      expect(ensureGitExclude(stray)).toBeNull();
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("findUserScopeInstall / removeUserScopeInstall", () => {
  const savedXdg = process.env.XDG_DATA_HOME;

  function restoreXdg(): void {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
  }

  it("returns null on a clean home", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      expect(findUserScopeInstall(home)).toBeNull();
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects a lock entry alone", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      const root = join(home, ".omp", "plugins");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true } }, settings: {} }),
        "utf8",
      );
      const found = findUserScopeInstall(home);
      expect(found).not.toBeNull();
      expect(found?.lockEntry).toBe(true);
      expect(found?.danglingLink).toBe(false);
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects a dangling symlink alone", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      const root = join(home, ".omp", "plugins");
      const linkPath = join(root, "node_modules", "@foreman", "omp-plugin");
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "nowhere"), linkPath);
      const found = findUserScopeInstall(home);
      expect(found).not.toBeNull();
      expect(found?.lockEntry).toBe(false);
      expect(found?.danglingLink).toBe(true);
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects both a lock entry and a dangling symlink together", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      const root = join(home, ".omp", "plugins");
      const linkPath = join(root, "node_modules", "@foreman", "omp-plugin");
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "nowhere"), linkPath);
      writeFileSync(
        join(root, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true } }, settings: {} }),
        "utf8",
      );
      const found = findUserScopeInstall(home);
      expect(found).not.toBeNull();
      expect(found?.lockEntry).toBe(true);
      expect(found?.danglingLink).toBe(true);
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("consults XDG_DATA_HOME first", () => {
    const home = makeTmp("home");
    const xdg = makeTmp("xdg");
    process.env.XDG_DATA_HOME = xdg;
    try {
      const root = join(xdg, "omp", "plugins");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true } }, settings: {} }),
        "utf8",
      );
      const found = findUserScopeInstall(home);
      expect(found).not.toBeNull();
      expect(found?.root).toBe(root);
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it("removal drops the lock entry, deletes the symlink, and prunes the empty @foreman scope dir", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      const root = join(home, ".omp", "plugins");
      const linkPath = join(root, "node_modules", "@foreman", "omp-plugin");
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "nowhere"), linkPath);
      writeFileSync(
        join(root, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true } }, settings: {} }),
        "utf8",
      );
      const install = findUserScopeInstall(home);
      expect(install).not.toBeNull();
      const result = removeUserScopeInstall(install!);
      expect(result.lockChanged).toBe(true);
      expect(result.linkRemoved).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
      expect(existsSync(dirname(linkPath))).toBe(false);

      const lock = JSON.parse(readFileSync(join(root, "omp-plugins.lock.json"), "utf8"));
      expect(lock.plugins["@foreman/omp-plugin"]).toBeUndefined();
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removal preserves other plugins' entries in the user lock", () => {
    const home = makeTmp("home");
    delete process.env.XDG_DATA_HOME;
    try {
      const root = join(home, ".omp", "plugins");
      const linkPath = join(root, "node_modules", "@foreman", "omp-plugin");
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(join(home, "nowhere"), linkPath);
      writeFileSync(
        join(root, "omp-plugins.lock.json"),
        JSON.stringify({
          plugins: {
            "@foreman/omp-plugin": { version: "1.2.3", enabledFeatures: null, enabled: true },
            "@other/plugin": { version: "0.1.0", enabledFeatures: null, enabled: true },
          },
          settings: {},
        }),
        "utf8",
      );
      const install = findUserScopeInstall(home);
      removeUserScopeInstall(install!);
      const lock = JSON.parse(readFileSync(join(root, "omp-plugins.lock.json"), "utf8"));
      expect(lock.plugins["@other/plugin"]).toEqual({ version: "0.1.0", enabledFeatures: null, enabled: true });
    } finally {
      restoreXdg();
      rmSync(home, { recursive: true, force: true });
    }
  });
});