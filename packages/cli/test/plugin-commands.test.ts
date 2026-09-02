import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOREMAN_MARKETPLACE_NAME,
  findPluginScopes,
  ompInstallArgv,
  ompMarketplaceAddArgv,
  ompUninstallUserArgv,
} from "../src/plugin-commands.ts";

describe("FOREMAN_MARKETPLACE_NAME", () => {
  it("matches the catalog's own declared name, so install can never resolve to the wrong marketplace", () => {
    const catalogPath = join(import.meta.dir, "..", "..", "..", ".omp-plugin", "marketplace.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { name: string };
    expect(catalog.name).toBe(FOREMAN_MARKETPLACE_NAME);
  });
});

describe("omp argv builders", () => {
  it("builds a marketplace add command", () => {
    expect(ompMarketplaceAddArgv("andyhite/foreman")).toEqual(["plugin", "marketplace", "add", "andyhite/foreman"]);
  });

  it("always installs at project scope, with no way to request user scope", () => {
    expect(ompInstallArgv("foreman")).toEqual(["plugin", "install", "foreman@foreman", "--scope", "project"]);
    // ompInstallArgv takes only a plugin name — there is no scope parameter to pass "user" through.
    expect(ompInstallArgv.length).toBe(1);
  });

  it("builds an uninstall command scoped to user, for removing a stray machine-wide install", () => {
    expect(ompUninstallUserArgv("foreman")).toEqual(["plugin", "uninstall", "--scope", "user", "foreman@foreman"]);
  });
});

describe("findPluginScopes", () => {
  it("does not misread a path containing 'project' as a project-scoped install", () => {
    const stdout = "foreman@foreman  /Users/dev/Projects/app  (linked)\n";
    expect(findPluginScopes(stdout, "foreman", "foreman")).toEqual({ project: false, user: false });
  });

  it("still matches a genuine project-scoped install", () => {
    const stdout = "foreman@foreman  project\n";
    expect(findPluginScopes(stdout, "foreman", "foreman")).toEqual({ project: true, user: false });
  });
});
