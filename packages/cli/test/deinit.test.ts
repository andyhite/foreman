import { activateRepoPlugin, repoPluginLockPath, repoPluginRoot } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeinit, type DeinitDeps, type DeinitOptions } from "../src/deinit.ts";
import type { Choice, CheckboxChoice, Prompter } from "../src/prompt.ts";

class ScriptedPrompter implements Prompter {
  confirmResult = true;

  text(_question: string, defaultValue: string): Promise<string> {
    return Promise.resolve(defaultValue);
  }

  confirm(_question: string, _defaultValue: boolean): Promise<boolean> {
    return Promise.resolve(this.confirmResult);
  }

  select<T extends string>(_question: string, _choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    return Promise.resolve(defaultValue);
  }

  secret(_question: string): Promise<string> {
    return Promise.resolve("");
  }

  multiSelect<T extends string>(_question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    return Promise.resolve(choices.filter((choice) => choice.checked).map((choice) => choice.value));
  }

  close(): void {
    // no-op
  }
}

/** Fakes `git rev-parse --show-toplevel`, the only git command `runDeinit` issues. */
class FakeGit {
  constructor(private readonly repoRoot: string | null) {}

  run(argv: string[], _options: { cwd: string }): Promise<{ stdout: string; stderr: string; code: number }> {
    if (argv.join(" ") !== "git rev-parse --show-toplevel" || this.repoRoot === null) {
      return Promise.reject(new Error("not a git repository"));
    }
    return Promise.resolve({ stdout: `${this.repoRoot}\n`, stderr: "", code: 0 });
  }
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-deinit-home-"));
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "foreman-deinit-repo-"));
}

/** A fixture plugin package: `package.json` with a version. */
function makePluginFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-deinit-plugin-fixture-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@foreman/omp-plugin", version: "1.2.3" }));
  return dir;
}

function seedGlobalLink(home: string, pluginDir: string): void {
  const linkPath = join(home, ".foreman", "plugin");
  mkdirSync(join(home, ".foreman"), { recursive: true });
  symlinkSync(pluginDir, linkPath);
}

function baseOptions(overrides: Partial<DeinitOptions>, home: string, cwd: string): DeinitOptions {
  return { cwd, home, keepRegistry: false, ...overrides };
}

describe("runDeinit", () => {
  it("removes the symlink and lock entry, and prunes the emptied directories", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = makeTempRepo();
    try {
      seedGlobalLink(home, pluginDir);
      activateRepoPlugin(repoRoot, home);

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      const deps: DeinitDeps = { prompter, git, log: () => {} };
      await runDeinit(baseOptions({ keepRegistry: true }, home, repoRoot), deps);

      expect(existsSync(join(repoRoot, ".omp"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps another plugin's lock entry and the lock file itself", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = makeTempRepo();
    try {
      seedGlobalLink(home, pluginDir);
      activateRepoPlugin(repoRoot, home);

      const lockPath = repoPluginLockPath(repoRoot);
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.plugins["some-other/plugin"] = { version: "0.1.0", enabledFeatures: null, enabled: true };
      writeFileSync(lockPath, JSON.stringify(lock, null, 2));

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      await runDeinit(baseOptions({ keepRegistry: true }, home, repoRoot), { prompter, git, log: () => {} });

      expect(existsSync(lockPath)).toBe(true);
      const remaining = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(remaining.plugins["@foreman/omp-plugin"]).toBeUndefined();
      expect(remaining.plugins["some-other/plugin"]).toEqual({
        version: "0.1.0",
        enabledFeatures: null,
        enabled: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("removes the registry entry by default", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    try {
      mkdirSync(join(home, ".foreman"), { recursive: true });
      writeFileSync(
        join(home, ".foreman", "config.json"),
        JSON.stringify({ repos: { plotroom: { path: repoRoot, team: "ENG" } } }),
      );

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      await runDeinit(baseOptions({}, home, repoRoot), { prompter, git, log: () => {} });

      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos?.plotroom).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps the registry entry with --keep-registry", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    try {
      mkdirSync(join(home, ".foreman"), { recursive: true });
      writeFileSync(
        join(home, ".foreman", "config.json"),
        JSON.stringify({ repos: { plotroom: { path: repoRoot, team: "ENG" } } }),
      );

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      await runDeinit(baseOptions({ keepRegistry: true }, home, repoRoot), { prompter, git, log: () => {} });

      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos.plotroom).toEqual({ path: repoRoot, team: "ENG" });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("is a no-op that does not throw in a never-initialised repo", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    try {
      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      const logs: string[] = [];

      await runDeinit(baseOptions({}, home, repoRoot), { prompter, git, log: (m) => logs.push(m) });

      expect(existsSync(repoPluginRoot(repoRoot))).toBe(false);
      expect(logs.some((line) => line.includes("nothing to remove"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("throws outside a git repository", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(null);
      const prompter = new ScriptedPrompter();

      await expect(
        runDeinit(baseOptions({}, home, "/tmp/not-a-repo"), { prompter, git, log: () => {} }),
      ).rejects.toThrow(/must be run inside a git repository/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
