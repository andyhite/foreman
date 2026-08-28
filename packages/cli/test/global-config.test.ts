import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGlobalConfig, writeLinearApiKeyFile } from "../src/global-config.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-cli-"));
}

describe("writeGlobalConfig", () => {
  it("writes repos and linear settings to a fresh config", () => {
    const home = makeHome();
    try {
      const path = writeGlobalConfig(
        {
          repos: { "initiative-1": "~/Code/app" },
          linear: { teamKeys: ["ENG"], apiKeyFile: "~/.foreman/linear-api-key" },
        },
        home,
      );
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.repos).toEqual({ "initiative-1": "~/Code/app" });
      expect(written.linear.teamKeys).toEqual(["ENG"]);
      expect(written.linear.apiKeyFile).toBe("~/.foreman/linear-api-key");
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
        JSON.stringify({ repos: { "initiative-existing": "/repo" }, loop: { wipGlobal: 7 } }),
        "utf8",
      );

      const path = writeGlobalConfig(
        { repos: { "initiative-added": "/repo2" }, linear: { teamKeys: [], apiKeyFile: null } },
        home,
      );
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.repos).toEqual({ "initiative-existing": "/repo", "initiative-added": "/repo2" });
      expect(written.loop.wipGlobal).toBe(7);
      expect(written.linear).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws rather than writing an invalid patch", () => {
    const home = makeHome();
    try {
      expect(() =>
        writeGlobalConfig(
          // @ts-expect-error deliberately wrong shape to exercise validation
          { repos: { "initiative-1": "/repo" }, linear: { teamKeys: "not-an-array", apiKeyFile: null } },
          home,
        ),
      ).toThrow(/Invalid global config/);
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
