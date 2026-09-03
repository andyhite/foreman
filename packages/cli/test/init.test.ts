import { loadGlobalConfig, repoPluginLinkPath, repoPluginLockPath } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInit, type InitDeps, type InitOptions } from "../src/init.ts";
import type { Choice, CheckboxChoice, Prompter } from "../src/prompt.ts";

class ScriptedPrompter implements Prompter {
  multiSelectResult: string[] | null = null;
  textAnswers: Record<string, string> = {};
  confirmAnswers: Record<string, boolean> = {};

  text(question: string, defaultValue: string): Promise<string> {
    return Promise.resolve(this.textAnswers[question] ?? defaultValue);
  }

  confirm(question: string, defaultValue: boolean): Promise<boolean> {
    return Promise.resolve(this.confirmAnswers[question] ?? defaultValue);
  }

  select<T extends string>(_question: string, _choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    return Promise.resolve(defaultValue);
  }

  secret(_question: string): Promise<string> {
    return Promise.resolve("");
  }

  multiSelect<T extends string>(_question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    if (this.multiSelectResult) return Promise.resolve(this.multiSelectResult as T[]);
    return Promise.resolve(choices.filter((choice) => choice.checked).map((choice) => choice.value));
  }

  close(): void {
    // no-op
  }
}

/** Fakes exactly the git subcommands `runInit` issues, keyed by argv joined with spaces. */
class FakeGit {
  calls: Array<{ argv: string[]; cwd: string }> = [];
  private readonly responses: Record<string, string>;
  private readonly failing: Set<string>;

  constructor(responses: Record<string, string>, failing: string[] = []) {
    this.responses = responses;
    this.failing = new Set(failing);
  }

  run(argv: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string; code: number }> {
    this.calls.push({ argv, cwd: options.cwd });
    const key = argv.join(" ");
    if (this.failing.has(key)) return Promise.reject(new Error(`command failed: ${key}`));
    const stdout = this.responses[key];
    if (stdout === undefined) return Promise.reject(new Error(`unmocked git command: ${key}`));
    return Promise.resolve({ stdout, stderr: "", code: 0 });
  }
}

function defaultGitResponses(repoRoot: string): Record<string, string> {
  return {
    "git rev-parse --show-toplevel": `${repoRoot}\n`,
    "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
  };
}

function baseOptions(overrides: Partial<InitOptions>, home: string, cwd: string): InitOptions {
  return { cwd, home, skipLinear: true, skipPlugin: false, ...overrides };
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-init-"));
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
}

/** A fixture plugin package: `package.json` with a version. */
function makePluginFixture(version = "1.2.3"): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-plugin-fixture-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@foreman/omp-plugin", version }));
  return dir;
}

/** Seeds `<home>/.foreman/plugin` the way `foreman setup` would, pointing at `pluginDir`. */
function seedGlobalLink(home: string, pluginDir: string): void {
  const linkPath = join(home, ".foreman", "plugin");
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(pluginDir, linkPath);
}

describe("runInit", () => {
  it("registers a fresh repo with one manually-entered initiative", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      const logs: string[] = [];
      const deps: InitDeps = { prompter, git, log: (message) => logs.push(message) };
      await runInit(baseOptions({}, home, "/repos/plotroom"), deps);

      const config = readConfig(home);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1"] },
      });
      expect(logs.some((line) => line.includes("foreman repo --once"))).toBe(true);

      const loaded = loadGlobalConfig({ home });
      expect(loaded.config.repos.plotroom?.path).toBe("/repos/plotroom");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("registers a monorepo with two initiatives, one carrying a subdirectory hint", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/mono"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i2";
      prompter.textAnswers['Subdirectory for initiative "i2" (blank = repo root)'] = "apps/zero";

      const deps: InitDeps = { prompter, git, log: () => {} };
      await runInit(baseOptions({}, home, "/repos/mono"), deps);

      const config = readConfig(home);
      expect(config.repos).toEqual({
        mono: { path: "/repos/mono", initiatives: ["i1", { id: "i2", path: "apps/zero" }] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("updates the existing entry on re-run instead of duplicating the alias", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const first = new ScriptedPrompter();
      first.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter: first, git, log: () => {} });

      const second = new ScriptedPrompter();
      // Default for the manual-ids prompt should now be pre-filled with "i1" — confirm by adding i2.
      second.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i2";
      const logs: string[] = [];
      await runInit(baseOptions({}, home, "/repos/plotroom"), {
        prompter: second,
        git,
        log: (m) => logs.push(m),
      });

      const config = readConfig(home);
      expect(Object.keys(config.repos as object)).toEqual(["plotroom"]);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1", "i2"] },
      });
      expect(logs.some((line) => line.includes("already registered"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches an existing home-relative path and atomically renames its alias", async () => {
    const home = makeTempHome();
    const repoRoot = join(home, "repos", "plotroom");
    try {
      const configDir = join(home, ".foreman");
      mkdirSync(configDir);
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ repos: { old: { path: "~/repos/plotroom", initiatives: ["i1"] } } }),
      );
      const git = new FakeGit(defaultGitResponses(repoRoot));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Registry alias for this repo"] = "new";

      await runInit(baseOptions({}, home, repoRoot), { prompter, git, log: () => {} });

      expect(readConfig(home).repos).toEqual({
        new: { path: repoRoot, initiatives: ["i1"] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects duplicate initiative ids before writing the config", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i1";

      await expect(
        runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} }),
      ).rejects.toThrow(/both "plotroom" and "plotroom"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits team when the answer is blank", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      // Team prompt defaults to "" and ScriptedPrompter returns the default when unanswered.

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} });

      const config = readConfig(home);
      const entry = (config.repos as Record<string, Record<string, unknown>>).plotroom;
      expect(entry?.team).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits baseBranch when the default branch is main and writes it otherwise", async () => {
    const homeMain = makeTempHome();
    const homeOther = makeTempHome();
    try {
      const gitMain = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const promptMain = new ScriptedPrompter();
      promptMain.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, homeMain, "/repos/plotroom"), {
        prompter: promptMain,
        git: gitMain,
        log: () => {},
      });
      const configMain = readConfig(homeMain);
      expect((configMain.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBeUndefined();

      const gitOther = new FakeGit({
        "git rev-parse --show-toplevel": "/repos/plotroom\n",
        "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n",
      });
      const promptOther = new ScriptedPrompter();
      promptOther.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, homeOther, "/repos/plotroom"), {
        prompter: promptOther,
        git: gitOther,
        log: () => {},
      });
      const configOther = readConfig(homeOther);
      expect((configOther.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBe("trunk");
    } finally {
      rmSync(homeMain, { recursive: true, force: true });
      rmSync(homeOther, { recursive: true, force: true });
    }
  });

  it("writes baseBranch when the repo's default branch differs from a non-default repoDefaults.baseBranch", async () => {
    const home = makeTempHome();
    try {
      mkdirSync(join(home, ".foreman"), { recursive: true });
      writeFileSync(
        join(home, ".foreman", "config.json"),
        JSON.stringify({ repoDefaults: { baseBranch: "trunk" } }),
      );

      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} });

      const config = readConfig(home);
      expect((config.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBe("main");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits baseBranch when the repo's default branch matches a non-default repoDefaults.baseBranch", async () => {
    const home = makeTempHome();
    try {
      mkdirSync(join(home, ".foreman"), { recursive: true });
      writeFileSync(
        join(home, ".foreman", "config.json"),
        JSON.stringify({ repoDefaults: { baseBranch: "trunk" } }),
      );

      const git = new FakeGit({
        "git rev-parse --show-toplevel": "/repos/plotroom\n",
        "git symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n",
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} });

      const config = readConfig(home);
      expect((config.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to the current branch when there's no origin/HEAD ref", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(
        {
          "git rev-parse --show-toplevel": "/repos/plotroom\n",
          "git rev-parse --abbrev-ref HEAD": "develop\n",
        },
        ["git symbolic-ref --short refs/remotes/origin/HEAD"],
      );
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} });

      const config = readConfig(home);
      expect((config.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBe("develop");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to repoDefaults.baseBranch when the repo has no commits at all", async () => {
    const home = makeTempHome();
    try {
      mkdirSync(join(home, ".foreman"), { recursive: true });
      writeFileSync(join(home, ".foreman", "config.json"), JSON.stringify({ repoDefaults: { baseBranch: "trunk" } }));

      // A repo with no commits has neither an origin/HEAD ref nor a current
      // branch resolvable via `rev-parse --abbrev-ref HEAD`; detectBaseBranch
      // must fall back to the caller-supplied default instead of throwing.
      const git = new FakeGit(
        { "git rev-parse --show-toplevel": "/repos/plotroom\n" },
        ["git symbolic-ref --short refs/remotes/origin/HEAD", "git rev-parse --abbrev-ref HEAD"],
      );
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: () => {} });

      const config = readConfig(home);
      // Falls back to "trunk" (repoDefaults.baseBranch), which equals the
      // effective default, so baseBranch is omitted from the written entry.
      expect((config.repos as Record<string, Record<string, unknown>>).plotroom?.baseBranch).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the Linear API to pick initiatives and pre-checks/hints existing bindings", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("query Initiatives")) {
        return new Response(
          JSON.stringify({
            data: {
              initiatives: {
                nodes: [
                  { id: "i1", name: "Plotroom Fleet" },
                  { id: "i2", name: "Plotroom Zero" },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );
      }
      if (query.includes("query Teams")) {
        return new Response(
          JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } } } }),
        );
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;

    // Restored, not deleted: `bun test` shares one process across files, so
    // unconditionally dropping the variable leaks this test's setup into every
    // later file that reads it (`foreman doctor` reports it as the credential).
    const ambientApiKey = process.env.LINEAR_API_KEY;
    try {
      process.env.LINEAR_API_KEY = "lin_api_test";

      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.multiSelectResult = ["i1", "i2"];

      await runInit(baseOptions({ skipLinear: false }, home, "/repos/plotroom"), {
        prompter,
        git,
        log: () => {},
      });

      const config = readConfig(home);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", team: "ENG", initiatives: ["i1", "i2"] },
      });
    } finally {
      if (ambientApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = ambientApiKey;
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to manual initiative ids when no API key resolves", async () => {
    const home = makeTempHome();
    /*
     * The premise is "no key resolves", so the ambient variable has to go for
     * the duration: with `$LINEAR_API_KEY` exported, `init` would reach the
     * real Linear API instead of the manual prompt and this test would assert
     * nothing about the fallback.
     */
    const ambientApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({ skipLinear: false }, home, "/repos/plotroom"), {
        prompter,
        git,
        log: () => {},
      });

      const config = readConfig(home);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1"] },
      });
    } finally {
      if (ambientApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = ambientApiKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws outside a git repository", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit({}, ["git rev-parse --show-toplevel"]);
      const prompter = new ScriptedPrompter();

      await expect(
        runInit(baseOptions({}, home, "/tmp/not-a-repo"), { prompter, git, log: () => {} }),
      ).rejects.toThrow(/must be run inside a git repository/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("registers a fresh repo non-interactively via --initiative flags", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      await runInit(
        baseOptions({ initiatives: ["i1", "i2:apps/zero"], alias: "plotroom", team: "ENG" }, home, "/repos/plotroom"),
        { prompter, git, log: () => {} },
      );

      expect(readConfig(home).repos).toEqual({
        plotroom: {
          path: "/repos/plotroom",
          team: "ENG",
          initiatives: ["i1", { id: "i2", path: "apps/zero" }],
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects empty --initiative values", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();

      await expect(
        runInit(baseOptions({ initiatives: [":subdir"] }, home, "/repos/plotroom"), { prompter, git, log: () => {} }),
      ).rejects.toThrow(/Invalid --initiative/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runInit — omp plugin activation (project scope)", () => {
  it("activates the plugin: symlink points at the global link, lock entry is enabled", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = mkdtempSync(join(tmpdir(), "foreman-init-repo-"));
    try {
      seedGlobalLink(home, pluginDir);
      const git = new FakeGit(defaultGitResponses(repoRoot));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, repoRoot), { prompter, git, log: () => {} });

      const linkPath = repoPluginLinkPath(repoRoot);
      expect(readlinkSync(linkPath)).toBe(join(home, ".foreman", "plugin"));

      const lock = JSON.parse(readFileSync(repoPluginLockPath(repoRoot), "utf8"));
      expect(lock.plugins["@foreman/omp-plugin"]).toEqual({ version: "1.2.3", enabledFeatures: null, enabled: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("is idempotent across two runs", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = mkdtempSync(join(tmpdir(), "foreman-init-repo-"));
    try {
      seedGlobalLink(home, pluginDir);
      const git = new FakeGit(defaultGitResponses(repoRoot));

      const first = new ScriptedPrompter();
      first.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, home, repoRoot), { prompter: first, git, log: () => {} });

      const second = new ScriptedPrompter();
      second.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];
      await runInit(baseOptions({}, home, repoRoot), { prompter: second, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("already linked"))).toBe(true);
      expect(logs.some((line) => line.includes("already up to date"))).toBe(true);
      const lock = JSON.parse(readFileSync(repoPluginLockPath(repoRoot), "utf8"));
      expect(lock.plugins["@foreman/omp-plugin"]).toEqual({ version: "1.2.3", enabledFeatures: null, enabled: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("--skip-plugin writes no .omp/", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = mkdtempSync(join(tmpdir(), "foreman-init-repo-"));
    try {
      seedGlobalLink(home, pluginDir);
      const git = new FakeGit(defaultGitResponses(repoRoot));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({ skipPlugin: true }, home, repoRoot), { prompter, git, log: () => {} });

      expect(existsSync(join(repoRoot, ".omp"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("warns but still registers the repo when the global link is missing", async () => {
    const home = makeTempHome();
    const repoRoot = mkdtempSync(join(tmpdir(), "foreman-init-repo-"));
    try {
      // No seedGlobalLink() call: `~/.foreman/plugin` does not exist.
      const git = new FakeGit(defaultGitResponses(repoRoot));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, repoRoot), { prompter, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("foreman setup"))).toBe(true);
      expect(existsSync(join(repoRoot, ".omp"))).toBe(false);
      const config = readConfig(home);
      const repos = config.repos as Record<string, { path: string; initiatives: string[] }>;
      const [alias, entry] = Object.entries(repos)[0] ?? [];
      expect(alias).toBeDefined();
      expect(entry).toEqual({ path: repoRoot, initiatives: ["i1"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("adds the .git/info/exclude line exactly once across two runs", async () => {
    const home = makeTempHome();
    const pluginDir = makePluginFixture();
    const repoRoot = mkdtempSync(join(tmpdir(), "foreman-init-repo-"));
    mkdirSync(join(repoRoot, ".git", "info"), { recursive: true });
    try {
      seedGlobalLink(home, pluginDir);
      const git = new FakeGit(defaultGitResponses(repoRoot));

      const first = new ScriptedPrompter();
      first.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, home, repoRoot), { prompter: first, git, log: () => {} });

      const second = new ScriptedPrompter();
      second.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, home, repoRoot), { prompter: second, git, log: () => {} });

      const excludeContents = readFileSync(join(repoRoot, ".git", "info", "exclude"), "utf8");
      const occurrences = excludeContents.split("\n").filter((line) => line.trim() === "/.omp/plugins/").length;
      expect(occurrences).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("runInit — GitHub App installation check", () => {
  function seedGithubApp(home: string): void {
    mkdirSync(join(home, ".foreman"), { recursive: true });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPath = join(home, ".foreman", "github-app-private-key.pem");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    writeFileSync(
      join(home, ".foreman", "config.json"),
      JSON.stringify({ githubApp: { appId: "999", privateKeyFile: keyPath } }),
    );
  }

  it("is silent when no GitHub App is configured", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("GitHub App"))).toBe(false);
      expect(git.calls.some((call) => call.argv.join(" ").startsWith("gh repo view"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("confirms an existing installation", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response(JSON.stringify({ id: 1 }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("installed on acme/plotroom"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("opens the install page when the operator confirms (default yes) and openUrl is wired in", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response("not found", { status: 404 });
      }
      if (String(url).endsWith("/app")) {
        return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const opened: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), {
        prompter,
        git,
        log: () => {},
        openUrl: (url) => opened.push(url),
      });

      expect(opened).toEqual(["https://github.com/apps/foreman-review/installations/new"]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never calls openUrl when the operator declines the confirm", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response("not found", { status: 404 });
      }
      if (String(url).endsWith("/app")) {
        return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      prompter.confirmAnswers["Open that install page in your browser now?"] = false;
      const opened: string[] = [];
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), {
        prompter,
        git,
        log: (m) => logs.push(m),
        openUrl: (url) => opened.push(url),
      });

      expect(opened).toEqual([]);
      // The install URL itself is still printed — declining the auto-open
      // never costs the operator the link to click by hand later.
      expect(logs.some((line) => line.includes("https://github.com/apps/foreman-review/installations/new"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never calls openUrl when the App is already installed", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response(JSON.stringify({ id: 1 }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const opened: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), {
        prompter,
        git,
        log: () => {},
        openUrl: (url) => opened.push(url),
      });

      expect(opened).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never calls openUrl when it isn't wired in (non-interactive runs)", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response("not found", { status: 404 });
      }
      if (String(url).endsWith("/app")) {
        return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      // No `openUrl` in deps at all — mirrors `main.ts` omitting it for `--yes`/piped runs.
      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("opening that link"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("points at the install page when the App is not installed on this repo", async () => {
    const home = makeTempHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/repos/acme/plotroom/installation")) {
        return new Response("not found", { status: 404 });
      }
      if (String(url).endsWith("/app")) {
        return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      seedGithubApp(home);
      const git = new FakeGit({
        ...defaultGitResponses("/repos/plotroom"),
        "gh repo view --json owner,name": JSON.stringify({ owner: { login: "acme" }, name: "plotroom" }),
      });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("https://github.com/apps/foreman-review/installations/new"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
