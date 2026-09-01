import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGlobalConfig, writeLinearApiKeyFile } from "../src/global-config.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-cli-"));
}

describe("writeGlobalConfig", () => {
  it("writes repos registry entries and linear settings to a fresh config", () => {
    const home = makeHome();
    try {
      const path = writeGlobalConfig(
        {
          repos: {
            plotroom: { path: "~/Code/app", team: "ENG", initiatives: ["initiative-1"] },
          },
          linear: { apiKeyFile: "~/.foreman/linear-api-key" },
        },
        home,
      );
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.repos).toEqual({
        plotroom: { path: "~/Code/app", team: "ENG", initiatives: ["initiative-1"] },
      });
      expect(written.linear.apiKeyFile).toBe("~/.foreman/linear-api-key");
      expect(written.linear.teamKeys).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges onto an existing config without clobbering untouched keys", () => {
    const home = makeHome();
    try {
      const dir = join(home, ".foreman");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          repos: { existing: { path: "/repo", initiatives: ["initiative-existing"] } },
          loop: { wipGlobal: 7 },
        }),
        "utf8",
      );

      const path = writeGlobalConfig(
        {
          repos: { added: { path: "/repo2", initiatives: ["initiative-added"] } },
          linear: { apiKeyFile: null },
        },
        home,
      );
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.repos).toEqual({
        existing: { path: "/repo", initiatives: ["initiative-existing"] },
        added: { path: "/repo2", initiatives: ["initiative-added"] },
      });
      expect(written.loop.wipGlobal).toBe(7);
      expect(written.linear).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes renamed repo aliases without clobbering other registry entries", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(
        {
          repos: {
            old: { path: "/repo", initiatives: ["initiative-old"] },
            other: { path: "/other", initiatives: ["initiative-other"] },
          },
        },
        home,
      );

      const path = writeGlobalConfig(
        {
          repos: { renamed: { path: "/repo", initiatives: ["initiative-old"] } },
          removeRepos: ["old"],
        },
        home,
      );

      expect(JSON.parse(readFileSync(path, "utf8")).repos).toEqual({
        other: { path: "/other", initiatives: ["initiative-other"] },
        renamed: { path: "/repo", initiatives: ["initiative-old"] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws rather than writing an invalid patch", () => {
    const home = makeHome();
    try {
      expect(() =>
        writeGlobalConfig(
          { repos: { plotroom: { path: "/repo", initiatives: [] } }, linear: { apiKeyFile: null } },
          home,
        ),
      ).toThrow(/Invalid global config/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names the config path when JSON is malformed", () => {
    const home = makeHome();
    try {
      const configDir = join(home, ".foreman");
      mkdirSync(configDir);
      writeFileSync(join(configDir, "config.json"), "{not json", "utf8");
      expect(() => writeGlobalConfig({ linear: { apiKeyFile: "~/.foreman/linear-api-key" } }, home)).toThrow(
        /Malformed config at .*config\.json/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes atomically via rename without leaving temp files behind", () => {
    const home = makeHome();
    try {
      const configPath = writeGlobalConfig({ linear: { apiKeyFile: "~/.foreman/linear-api-key" } }, home);
      const dirEntries = readdirSync(join(home, ".foreman"));
      expect(dirEntries).toEqual(["config.json"]);
      expect(readFileSync(configPath, "utf8")).toContain("linear-api-key");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("writeLinearApiKeyFile", () => {
  it("writes the key trimmed with newline and mode 0600", () => {
    const home = makeHome();
    try {
      const path = writeLinearApiKeyFile("  lin_api_abc123  ", home);
      expect(readFileSync(path, "utf8")).toBe("lin_api_abc123\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
