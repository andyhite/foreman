import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  expandHome,
  loadGlobalConfig,
  lockTtlMs,
  repoForProject,
  resolveLinearApiKey,
  resolveRepoConfig,
} from "../src/config/index.ts";
import type { GlobalConfig } from "../src/config/schema.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-config-"));
}

function writeGlobalConfig(home: string, contents: unknown): void {
  const dir = join(home, ".foreman");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(contents), "utf8");
}

function writeRepoConfig(repoPath: string, contents: unknown): void {
  const dir = join(repoPath, ".foreman");
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

  it("warns but does not throw when projects is empty", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { projects: {} });
      const { warnings } = loadGlobalConfig({ home });
      expect(warnings.some((w) => w.toLowerCase().includes("project"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoConfig", () => {
  it("deep-merges repoDefaults with the repo file, repo winning, siblings kept", () => {
    const home = makeHome();
    const repo = mkdtempSync(join(tmpdir(), "foreman-repo-"));
    try {
      writeGlobalConfig(home, { repoDefaults: { pr: { required: true, draft: false } } });
      writeRepoConfig(repo, { pr: { draft: true } });
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoConfig(config, repo);
      expect(resolved.pr.draft).toBe(true);
      expect(resolved.pr.required).toBe(true);
      expect(resolved.pr.ciRequired).toBe(true);
      expect(resolved.repoPath).toBe(repo);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back entirely to repoDefaults when no repo file exists", () => {
    const home = makeHome();
    const repo = mkdtempSync(join(tmpdir(), "foreman-repo-"));
    try {
      const { config } = loadGlobalConfig({ home });
      const resolved = resolveRepoConfig(config, repo);
      expect(resolved.baseBranch).toBe("main");
      expect(resolved.merge.strategy).toBe("squash");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("repoForProject", () => {
  it("expands a leading ~ using the given home", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { projects: { "proj-1": "~/code/plotroom" } });
      const { config } = loadGlobalConfig({ home });
      expect(repoForProject(config, "proj-1", home)).toBe(join(home, "code", "plotroom"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the project id for an unmapped project", () => {
    const home = makeHome();
    try {
      const { config } = loadGlobalConfig({ home });
      expect(() => repoForProject(config, "unmapped-project")).toThrow(ConfigError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
