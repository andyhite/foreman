import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOREMAN_MARKETPLACE_NAME,
  findPluginScopes,
  ompInstallArgv,
  ompMarketplaceAddArgv,
  ompPluginListArgv,
  ompUninstallUserArgv,
} from "../src/plugin-commands.ts";
import { OMP_PLUGIN_LIST_TABLE, ompPluginListJson } from "./omp-fixtures.ts";

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

  it("probes the plugin list as json, the only form that states the scope unambiguously", () => {
    expect(ompPluginListArgv()).toEqual(["plugin", "list", "--json"]);
  });
});

describe("findPluginScopes", () => {
  it("reads a project-scoped install out of what omp actually prints", () => {
    expect(findPluginScopes(ompPluginListJson(["project"]), "foreman", "foreman")).toEqual({
      project: true,
      user: false,
    });
  });

  it("reports both scopes when the plugin is installed twice, so init can warn about the machine-wide copy", () => {
    expect(findPluginScopes(ompPluginListJson(["project", "user"]), "foreman", "foreman")).toEqual({
      project: true,
      user: true,
    });
  });

  it("reports no install for an empty marketplace list, which is an answer rather than a failure", () => {
    expect(findPluginScopes(ompPluginListJson([]), "foreman", "foreman")).toEqual({ project: false, user: false });
  });

  it("ignores a different plugin's entry, whatever its scope", () => {
    const other = ompPluginListJson(["project"]).replace("foreman@foreman", "somethingelse@foreman");
    expect(findPluginScopes(other, "foreman", "foreman")).toEqual({ project: false, user: false });
  });

  it("returns null for the human table, rather than mistaking unparsed output for an absent install", () => {
    // The regression this file exists to prevent: the table says the plugin
    // *is* project-installed, so anything but null here is a false negative
    // that sends the operator to `foreman init` in an initialized repo.
    expect(findPluginScopes(OMP_PLUGIN_LIST_TABLE, "foreman", "foreman")).toBeNull();
  });

  it("returns null for json that is not a plugin list", () => {
    expect(findPluginScopes(`{"error":"unknown flag --json"}`, "foreman", "foreman")).toBeNull();
  });

  it("cannot mistake an install path for a scope, however that path is named", () => {
    // Kept from the review that first flagged it, re-expressed in the shape
    // the parser now reads: scope is a typed field, so a path spelling
    // "Projects" cannot reach the answer at all.
    const listed = ompPluginListJson(["user"]).replace(
      "/Users/dev/.omp/plugins/cache/plugins/foreman___foreman___0.1.0",
      "/Users/dev/Projects/app/.omp/plugins/project",
    );
    expect(findPluginScopes(listed, "foreman", "foreman")).toEqual({ project: false, user: true });
  });
});
