import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  boundInitiativeIds,
  entryForCwd,
  expandHome,
  initiativeIndex,
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
      expect(config.loop.wipGlobal).toBe(3);
      expect(config.loop.backpressureThreshold).toBe(5);
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

  it("accepts backpressureThreshold: 0 and keeps it 0 (strictest, not off)", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { backpressureThreshold: 0 } });
      const { config } = loadGlobalConfig({ home });
      expect(config.loop.backpressureThreshold).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a negative wipGlobal", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { wipGlobal: -1 } });
      expect(() => loadGlobalConfig({ home })).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a non-integer wipGlobal", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { loop: { wipGlobal: 1.5 } });
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

  it("throws ConfigError when an initiative is bound to two entries", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: {
          plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] },
          zero: { path: "~/code/zero", initiatives: ["init-1"] },
        },
      });
      try {
        loadGlobalConfig({ home });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const configError = error as ConfigError;
        expect(configError.problems.some((p) => p.includes("init-1") && p.includes("plotroom") && p.includes("zero"))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoEntry", () => {
  it("deep-merges repoDefaults with the entry, entry winning, siblings kept", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repoDefaults: { pr: { required: true, draft: false } },
        repos: {
          plotroom: { path: "~/code/plotroom", initiatives: ["init-1"], pr: { draft: true } },
        },
      });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoEntry(config, "plotroom", home);
      expect(resolved.pr.draft).toBe(true);
      expect(resolved.pr.required).toBe(true);
      expect(resolved.pr.ciRequired).toBe(true);
      expect(resolved.repoPath).toBe(join(home, "code", "plotroom"));
      expect(resolved.alias).toBe("plotroom");
      expect(resolved.initiativeIds).toEqual(["init-1"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back entirely to repoDefaults when the entry has no overrides", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
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
            initiatives: ["init-1"],
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
});

describe("entryForCwd", () => {
  it("matches an exact registered path", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
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
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
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
          outer: { path: "~/code/plotroom", initiatives: ["init-1"] },
          inner: { path: "~/code/plotroom/apps/zero", initiatives: ["init-2"] },
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
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
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
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
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

describe("initiativeIndex", () => {
  it("indexes both bare-string and {id,path} bindings by alias", () => {
    const entries: Record<string, RepoEntry> = {
      plotroom: {
        path: "~/code/plotroom",
        initiatives: ["init-fleet", { id: "init-zero", path: "apps/zero" }],
      },
    };
    const config = { repos: entries } as unknown as GlobalConfig;
    expect(initiativeIndex(config)).toEqual({ "init-fleet": "plotroom", "init-zero": "plotroom" });
  });
});

describe("boundInitiativeIds", () => {
  it("discards path hints and returns bare ids", () => {
    const entry: RepoEntry = {
      path: "~/code/plotroom",
      initiatives: ["init-fleet", { id: "init-zero", path: "apps/zero" }],
    } as RepoEntry;
    expect(boundInitiativeIds(entry)).toEqual(["init-fleet", "init-zero"]);
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
