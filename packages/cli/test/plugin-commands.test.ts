import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOREMAN_MARKETPLACE_NAME,
  ompInstallArgv,
  ompLinkArgv,
  ompMarketplaceAddArgv,
} from "../src/plugin-commands.ts";

describe("FOREMAN_MARKETPLACE_NAME", () => {
  it("matches the catalog's own declared name, so install can never resolve to the wrong marketplace", () => {
    const catalogPath = join(import.meta.dir, "..", "..", "..", ".omp-plugin", "marketplace.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { name: string };
    expect(catalog.name).toBe(FOREMAN_MARKETPLACE_NAME);
  });
});

describe("omp argv builders", () => {
  it("builds a link command with scope", () => {
    expect(ompLinkArgv("/repo/packages/omp-plugin", "user")).toEqual([
      "plugin",
      "link",
      "/repo/packages/omp-plugin",
      "--scope",
      "user",
    ]);
  });

  it("builds a marketplace add command", () => {
    expect(ompMarketplaceAddArgv("andyhite/foreman")).toEqual(["plugin", "marketplace", "add", "andyhite/foreman"]);
  });

  it("builds an install command scoped to the fixed marketplace name", () => {
    expect(ompInstallArgv("foreman", "project")).toEqual([
      "plugin",
      "install",
      "foreman@foreman",
      "--scope",
      "project",
    ]);
  });
});
