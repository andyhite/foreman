import { loadGlobalConfig } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/exec.ts";
import type { Choice, CheckboxChoice, Prompter } from "../src/prompt.ts";
import { runInit, type InitDeps, type InitOptions } from "../src/init.ts";
import { OMP_PLUGIN_LIST_TABLE, ompPluginListJson } from "./omp-fixtures.ts";

class ScriptedPrompter implements Prompter {
  multiSelectResult: string[] | null = null;
  textAnswers: Record<string, string> = {};

  text(question: string, defaultValue: string): Promise<string> {
    return Promise.resolve(this.textAnswers[question] ?? defaultValue);
  }

  confirm(_question: string, defaultValue: boolean): Promise<boolean> {
    return Promise.resolve(defaultValue);
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

/**
 * Fakes the omp probes `installProjectPlugin` issues. `omp` is missing by
 * default so plugin tests unrelated to the install itself see it skip
 * quietly, the same way a machine without omp does.
 */
class FakeRunner implements Runner {
  calls: Array<{ bin: string; argv: string[]; cwd?: string }> = [];
  private readonly missing: Set<string>;
  private readonly failing: Set<string>;
  private readonly listStdout: string;

  constructor(options: { missing?: string[]; failing?: string[]; listStdout?: string } = {}) {
    this.missing = new Set(options.missing ?? ["omp"]);
    this.failing = new Set(options.failing ?? []);
    this.listStdout = options.listStdout ?? "";
  }

  run(bin: string, argv: string[], options?: { cwd?: string }): Promise<number> {
    this.calls.push({ bin, argv, cwd: options?.cwd });
    return Promise.resolve(this.failing.has(bin) ? 1 : 0);
  }

  capture(bin: string, argv: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ bin, argv, cwd: options?.cwd });
    return Promise.resolve({ code: this.failing.has(bin) ? 1 : 0, stdout: this.listStdout, stderr: "" });
  }

  exists(bin: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(bin));
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

describe("runInit", () => {
  it("registers a fresh repo with one manually-entered initiative", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      const logs: string[] = [];
      const deps: InitDeps = { prompter, git, runner, log: (message) => logs.push(message) };
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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i2";
      prompter.textAnswers['Subdirectory for initiative "i2" (blank = repo root)'] = "apps/zero";

      const deps: InitDeps = { prompter, git, runner, log: () => {} };
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
      const runner = new FakeRunner();
      const first = new ScriptedPrompter();
      first.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter: first, git, runner, log: () => {} });

      const second = new ScriptedPrompter();
      // Default for the manual-ids prompt should now be pre-filled with "i1" — confirm by adding i2.
      second.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i2";
      const logs: string[] = [];
      await runInit(baseOptions({}, home, "/repos/plotroom"), {
        prompter: second,
        git,
        runner,
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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Registry alias for this repo"] = "new";

      await runInit(baseOptions({}, home, repoRoot), { prompter, git, runner, log: () => {} });

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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1, i1";

      await expect(
        runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} }),
      ).rejects.toThrow(/both "plotroom" and "plotroom"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("omits team when the answer is blank", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      // Team prompt defaults to "" and ScriptedPrompter returns the default when unanswered.

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

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
        runner: new FakeRunner(),
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
        runner: new FakeRunner(),
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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

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
              },
            },
          }),
        );
      }
      if (query.includes("query Teams")) {
        return new Response(
          JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } } }),
        );
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;

    try {
      process.env.LINEAR_API_KEY = "lin_api_test";

      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.multiSelectResult = ["i1", "i2"];

      await runInit(baseOptions({ skipLinear: false }, home, "/repos/plotroom"), {
        prompter,
        git,
        runner,
        log: () => {},
      });

      const config = readConfig(home);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", team: "ENG", initiatives: ["i1", "i2"] },
      });
    } finally {
      delete process.env.LINEAR_API_KEY;
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to manual initiative ids when no API key resolves", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({ skipLinear: false }, home, "/repos/plotroom"), {
        prompter,
        git,
        runner,
        log: () => {},
      });

      const config = readConfig(home);
      expect(config.repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1"] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws outside a git repository", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit({}, ["git rev-parse --show-toplevel"]);
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();

      await expect(
        runInit(baseOptions({}, home, "/tmp/not-a-repo"), { prompter, git, runner, log: () => {} }),
      ).rejects.toThrow(/must be run inside a git repository/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("registers a fresh repo non-interactively via --initiative flags", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();
      await runInit(
        baseOptions({ initiatives: ["i1", "i2:apps/zero"], alias: "plotroom", team: "ENG" }, home, "/repos/plotroom"),
        { prompter, git, runner, log: () => {} },
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
      const runner = new FakeRunner();
      const prompter = new ScriptedPrompter();

      await expect(
        runInit(baseOptions({ initiatives: [":subdir"] }, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} }),
      ).rejects.toThrow(/Invalid --initiative/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runInit — omp plugin (project scope)", () => {
  it("installs the plugin at project scope with cwd set to the repo root", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [] });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

      const installCall = runner.calls.find((call) => call.bin === "omp" && call.argv[1] === "install");
      expect(installCall?.argv).toEqual(["plugin", "install", "foreman@foreman", "--scope", "project"]);
      expect(installCall?.cwd).toBe("/repos/plotroom");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--skip-plugin installs nothing", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [] });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";

      await runInit(baseOptions({ skipPlugin: true }, home, "/repos/plotroom"), { prompter, git, runner, log: () => {} });

      expect(runner.calls).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips without throwing and still writes the registry entry when omp is missing", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: ["omp"] });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: (m) => logs.push(m) });

      expect(runner.calls.some((call) => call.bin === "omp")).toBe(false);
      expect(logs.some((line) => line.includes("omp not found on PATH"))).toBe(true);
      expect(readConfig(home).repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1"] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips the install and says so when the plugin is already installed at project scope", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [], listStdout: ompPluginListJson(["project"]) });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: (m) => logs.push(m) });

      expect(runner.calls.some((call) => call.argv[1] === "install")).toBe(false);
      expect(logs.some((line) => line.includes("already installed at project scope"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("warns about a lingering user-scoped install after a successful project install", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [], listStdout: ompPluginListJson(["user"]) });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: (m) => logs.push(m) });

      expect(runner.calls.some((call) => call.argv[1] === "install")).toBe(true);
      expect(logs.some((line) => line.includes("machine-wide (user-scope) install"))).toBe(true);
      expect(logs.some((line) => line.includes("plugin uninstall --scope user foreman@foreman"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still attempts the install, and says why, when the plugin list cannot be read", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [], listStdout: OMP_PLUGIN_LIST_TABLE });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: (m) => logs.push(m) });

      expect(runner.calls.some((call) => call.argv[1] === "install")).toBe(true);
      expect(logs.some((line) => line.includes("could not read"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("logs a warning and continues when the install command fails", async () => {
    const home = makeTempHome();
    try {
      const git = new FakeGit(defaultGitResponses("/repos/plotroom"));
      const runner = new FakeRunner({ missing: [], failing: ["omp"] });
      const prompter = new ScriptedPrompter();
      prompter.textAnswers["Linear initiative id(s) this repo hosts (comma-separated)"] = "i1";
      const logs: string[] = [];

      await runInit(baseOptions({}, home, "/repos/plotroom"), { prompter, git, runner, log: (m) => logs.push(m) });

      expect(logs.some((line) => line.includes("omp plugin install failed"))).toBe(true);
      expect(readConfig(home).repos).toEqual({
        plotroom: { path: "/repos/plotroom", initiatives: ["i1"] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
