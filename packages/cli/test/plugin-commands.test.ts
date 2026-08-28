import { describe, expect, it } from "bun:test";
import {
  herdrInstallArgv,
  herdrLinkArgv,
  marketplaceNameFor,
  ompInstallArgv,
  ompLinkArgv,
  ompMarketplaceAddArgv,
} from "../src/plugin-commands.ts";

describe("marketplaceNameFor", () => {
  it("takes the repo name off an owner/repo slug", () => {
    expect(marketplaceNameFor("andyhite/foreman")).toBe("foreman");
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

  it("builds an install command scoped to the derived marketplace name", () => {
    expect(ompInstallArgv("foreman", "andyhite/foreman", "project")).toEqual([
      "plugin",
      "install",
      "foreman@foreman",
      "--scope",
      "project",
    ]);
  });
});

describe("herdr argv builders", () => {
  it("builds a link command", () => {
    expect(herdrLinkArgv("/repo/packages/herdr-plugin")).toEqual(["plugin", "link", "/repo/packages/herdr-plugin"]);
  });

  it("builds an install command with the subdir appended", () => {
    expect(herdrInstallArgv("andyhite/foreman", "packages/herdr-plugin")).toEqual([
      "plugin",
      "install",
      "andyhite/foreman/packages/herdr-plugin",
    ]);
  });
});
