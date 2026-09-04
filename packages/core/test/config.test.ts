import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  defaultAndValidateGlobalConfig,
  entryForCwd,
  expandHome,
  teamIndex,
  loadGlobalConfig,
  lockTtlMs,
  resolveLinearApiKey,
  resolveRepoEntry,
} from "../src/config/index.ts";
import type { GlobalConfig, RepoEntry } from "../src/config/schema.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-config-"));
}

function writeGlobalConfig(home: string, contents: unknown): void {
  const dir = join(home, ".foreman");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(contents), "utf8");
}

describe("loadGlobalConfig", () => {
  it("returns fully defaulted config plus a warning when the file is missing", () => {
    const home = makeHome();
    try {
      const { config, sources, warnings } = loadGlobalConfig({ home });
      expect(config.loop.concurrency.build).toBe(3);
      expect(config.loop.pollSeconds).toBe(20);
      expect(sources).toEqual([]);
      expect(warnings.some((w) => w.includes(join(home, ".foreman", "config.json")))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the pointer for an unknown top-level key", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { bogus: true });
      expect(() => loadGlobalConfig({ home })).toThrow(ConfigError);
      try {
        loadGlobalConfig({ home });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const configError = error as ConfigError;
        expect(configError.problems.some((p) => p.includes("/bogus"))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the pointer for an unknown nested key", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { bogusNested: 1 } });
      try {
        loadGlobalConfig({ home });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const configError = error as ConfigError;
        expect(configError.problems.some((p) => p.includes("/loop/bogusNested"))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts triageBatch: 1 and keeps it 1 (strictest, not off)", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { triageBatch: 1 } });
      const { config } = loadGlobalConfig({ home });
      expect(config.loop.triageBatch).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a negative concurrency.build", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { concurrency: { build: -1 } } });
      expect(() => loadGlobalConfig({ home })).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a non-integer concurrency.build", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { concurrency: { build: 1.5 } } });
      expect(() => loadGlobalConfig({ home })).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });


  it("warns but does not throw when repos is empty", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { repos: {} });
      const { warnings } = loadGlobalConfig({ home });
      expect(warnings.some((w) => w.toLowerCase().includes("repo"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError when a team is bound to two entries", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: {
          plotroom: { path: "~/code/plotroom", team: "ENG" },
          zero: { path: "~/code/zero", team: "ENG" },
        },
      });
      try {
        loadGlobalConfig({ home });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const configError = error as ConfigError;
        expect(configError.problems.some((p) => p.includes("ENG") && p.includes("plotroom") && p.includes("zero"))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("defaultAndValidateGlobalConfig", () => {
  it("rejects an invalid agent.approvalMode literal", () => {
    expect(() => defaultAndValidateGlobalConfig({ agent: { approvalMode: "yolo!" } }, "test")).toThrow(ConfigError);
  });

  it("accepts every agent.approvalMode literal", () => {
    for (const mode of ["always-ask", "write", "yolo"] as const) {
      const config = defaultAndValidateGlobalConfig({ agent: { approvalMode: mode } }, "test");
      expect(config.agent.approvalMode).toBe(mode);
    }
  });

  it("defaults loop.mode to confirm", () => {
    const config = defaultAndValidateGlobalConfig({}, "test");
    expect(config.loop.mode).toBe("confirm");
  });

  it("accepts a loop.mode override", () => {
    const config = defaultAndValidateGlobalConfig({ loop: { mode: "yolo" } }, "test");
    expect(config.loop.mode).toBe("yolo");
  });

  it("rejects a bogus loop.mode value", () => {
    expect(() => defaultAndValidateGlobalConfig({ loop: { mode: "full-autonomy" } }, "test")).toThrow(ConfigError);
  });

  it("rejects an empty repos key", () => {
    expect(() =>
      defaultAndValidateGlobalConfig({ repos: { "": { path: "~/code/x", initiatives: [] } } }, "test"),
    ).toThrow(ConfigError);
  });

  it("rejects a whitespace-only repos key", () => {
    expect(() =>
      defaultAndValidateGlobalConfig({ repos: { "  ": { path: "~/code/x", initiatives: [] } } }, "test"),
    ).toThrow(ConfigError);
  });

  it("rejects a repos key containing a path separator or colon", () => {
    for (const alias of ["a/b", "a\\b", "a:b"]) {
      expect(() =>
        defaultAndValidateGlobalConfig({ repos: { [alias]: { path: "~/code/x", initiatives: [] } } }, "test"),
      ).toThrow(ConfigError);
    }
  });

  it("accepts cleanupMergedWorktrees: false", () => {
    const config = defaultAndValidateGlobalConfig({ loop: { cleanupMergedWorktrees: false } }, "test");
    expect(config.loop.cleanupMergedWorktrees).toBe(false);
  });

  it("defaults linear.operatorUserId to null", () => {
    const config = defaultAndValidateGlobalConfig({}, "test");
    expect(config.linear.operatorUserId).toBeNull();
  });

  it("accepts a linear.operatorUserId override", () => {
    const config = defaultAndValidateGlobalConfig({ linear: { operatorUserId: "user-abc" } }, "test");
    expect(config.linear.operatorUserId).toBe("user-abc");
  });

  it("rejects an empty linear.operatorUserId string", () => {
    expect(() => defaultAndValidateGlobalConfig({ linear: { operatorUserId: "" } }, "test")).toThrow(ConfigError);
  });


  it("throws ConfigError when an initiative is bound to two entries, even outside loadGlobalConfig", () => {
    expect(() =>
      defaultAndValidateGlobalConfig(
        {
          repos: {
            a: { path: "~/code/a", initiatives: ["init-1"] },
            b: { path: "~/code/b", initiatives: ["init-1"] },
          },
        },
        "test",
      ),
    ).toThrow(ConfigError);
  });
});

describe("resolveRepoEntry", () => {
  it("deep-merges repoDefaults with the entry, entry winning, siblings kept", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repoDefaults: { pr: { required: true, draft: false } },
        repos: {
          plotroom: { path: "~/code/plotroom", team: "ENG", pr: { draft: true } },
        },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.pr.draft).toBe(true);
      expect(resolved.pr.required).toBe(true);
      expect(resolved.pr.ciRequired).toBe(true);
      expect(resolved.repoPath).toBe(join(home, "code", "plotroom"));
      expect(resolved.alias).toBe("plotroom");
      expect(resolved.team).toBe("ENG");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back entirely to repoDefaults when the entry has no overrides", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.baseBranch).toBe("main");
      expect(resolved.merge.strategy).toBe("squash");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a sparse override's sibling keys at the repoDefaults value", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repoDefaults: { baseBranch: "trunk", merge: { strategy: "rebase", deleteBranch: false } },
        repos: {
          plotroom: {
            path: "~/code/plotroom",
            team: "ENG",
            merge: { strategy: "merge" },
          },
        },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.merge.strategy).toBe("merge");
      expect(resolved.merge.deleteBranch).toBe(false);
      expect(resolved.baseBranch).toBe("trunk");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError for an unknown alias", () => {
    const home = makeHome();
    try {
      const { config } = loadGlobalConfig({ home });
      expect(() => resolveRepoEntry(config, "unknown-alias", home)).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves apps and appNames from the entry", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: {
          plotroom: {
            path: "~/code/plotroom",
            team: "ENG",
            apps: [{ name: "fleet" }, { name: "zero" }],
          },
        },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.apps).toEqual([{ name: "fleet" }, { name: "zero" }]);
      expect(resolved.appNames).toEqual(["fleet", "zero"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("defaults apps/appNames to empty when the entry has none", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.apps).toEqual([]);
      expect(resolved.appNames).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("entryForCwd", () => {
  it("matches an exact registered path", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const cwd = join(home, "code", "plotroom");
      mkdirSync(cwd, { recursive: true });
      const resolved = entryForCwd(config, cwd, home);
      expect(resolved.alias).toBe("plotroom");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches from a subdirectory of the registered path", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const cwd = join(home, "code", "plotroom", "apps", "zero");
      mkdirSync(cwd, { recursive: true });
      const resolved = entryForCwd(config, cwd, home);
      expect(resolved.alias).toBe("plotroom");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers the longest matching path for a nested registered repo", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: {
          outer: { path: "~/code/plotroom", team: "ENG" },
          inner: { path: "~/code/plotroom/apps/zero", team: "ZERO" },
        },
      });
      const { config } = loadGlobalConfig({ home });
      const cwd = join(home, "code", "plotroom", "apps", "zero", "src");
      mkdirSync(cwd, { recursive: true });
      const resolved = entryForCwd(config, cwd, home);
      expect(resolved.alias).toBe("inner");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError when no entry matches", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const cwd = join(home, "somewhere", "else");
      mkdirSync(cwd, { recursive: true });
      expect(() => entryForCwd(config, cwd, home)).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("expands ~ in the registry path before matching", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const cwd = join(home, "code", "plotroom");
      mkdirSync(cwd, { recursive: true });
      const resolved = entryForCwd(config, cwd, home);
      expect(resolved.repoPath).toBe(cwd);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("teamIndex", () => {
  it("indexes each entry's team key by alias", () => {
    const entries: Record<string, RepoEntry> = {
      plotroom: { path: "~/code/plotroom", team: "ENG" },
      zero: { path: "~/code/zero", team: "ZERO" },
    };
    const config = { repos: entries } as unknown as GlobalConfig;
    expect(teamIndex(config)).toEqual({ ENG: "plotroom", ZERO: "zero" });
  });
});

describe("resolveLinearApiKey", () => {
  const baseConfig = (): GlobalConfig => loadGlobalConfig({ home: makeHome() }).config;

  it("prefers the env var named by linear.apiKeyEnv", () => {
    const config = baseConfig();
    const key = resolveLinearApiKey(config, { LINEAR_API_KEY: "env-key" });
    expect(key).toBe("env-key");
  });

  it("falls back to apiKeyFile's trimmed first line when the env var is unset", () => {
    const home = makeHome();
    try {
      const keyFile = join(home, "key.txt");
      writeFileSync(keyFile, "file-key\nsecond line\n", "utf8");
      chmodSync(keyFile, 0o600);
      writeGlobalConfig(home, { linear: { apiKeyFile: keyFile } });
      const { config } = loadGlobalConfig({ home });
      const key = resolveLinearApiKey(config, {});
      expect(key).toBe("file-key");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError explaining both options when neither is available", () => {
    const config = baseConfig();
    expect(() => resolveLinearApiKey(config, {})).toThrow(ConfigError);
  });

  it("throws ConfigError when apiKeyFile is readable by group or others", () => {
    if (process.platform === "win32") return;
    const home = makeHome();
    try {
      const keyFile = join(home, "key.txt");
      writeFileSync(keyFile, "file-key\n", "utf8");
      chmodSync(keyFile, 0o644);
      writeGlobalConfig(home, { linear: { apiKeyFile: keyFile } });
      const { config } = loadGlobalConfig({ home });
      expect(() => resolveLinearApiKey(config, {})).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("assertEndpointHostAllowed", () => {
  const configWithEndpoint = (endpoint: string, allowCustomEndpoint = false): GlobalConfig => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { linear: { endpoint, allowCustomEndpoint } });
      return loadGlobalConfig({ home }).config;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("throws ConfigError for an unparseable endpoint", () => {
    expect(() => configWithEndpoint("not a url")).toThrow(ConfigError);
  });

  it("throws ConfigError for a non-https scheme", () => {
    expect(() => configWithEndpoint("http://api.linear.app/graphql")).toThrow(ConfigError);
  });

  it("throws ConfigError for a disallowed https host", () => {
    expect(() => configWithEndpoint("https://evil.example.com/graphql")).toThrow(ConfigError);
  });

  it("allows the default https://api.linear.app/graphql endpoint", () => {
    const config = configWithEndpoint("https://api.linear.app/graphql");
    expect(config.linear.endpoint).toBe("https://api.linear.app/graphql");
  });

  it("allows a custom https host when allowCustomEndpoint is set", () => {
    const config = configWithEndpoint("https://custom.example.com/graphql", true);
    expect(config.linear.endpoint).toBe("https://custom.example.com/graphql");
  });
});

describe("lockTtlMs", () => {
  it("computes 2 × maxRuntimeMs + lockTtlMarginMs", () => {
    const home = makeHome();
    try {
      const { config } = loadGlobalConfig({ home });
      expect(lockTtlMs(config)).toBe(2 * config.agent.maxRuntimeMs + config.agent.lockTtlMarginMs);
      expect(lockTtlMs(config)).toBe(2 * 7_200_000 + 1_800_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/... , leaves other paths unchanged", () => {
    expect(expandHome("~", "/home/x")).toBe("/home/x");
    expect(expandHome("~/foo", "/home/x")).toBe(join("/home/x", "foo"));
    expect(expandHome("/abs/path", "/home/x")).toBe("/abs/path");
  });
});
