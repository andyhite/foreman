import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBinDir } from "../src/cli-link.ts";
import type { Runner } from "../src/exec.ts";
import type { Choice, CheckboxChoice, Prompter } from "../src/prompt.ts";
import { runWizard, type WizardOptions } from "../src/wizard.ts";

class ScriptedPrompter implements Prompter {
  confirmCalls: string[] = [];
  multiSelectResult: string[] | null = null;
  textAnswers: Record<string, string> = {};
  secretAnswer = "";
  private confirmScript: boolean[];

  constructor(confirmScript: boolean[] = []) {
    this.confirmScript = [...confirmScript];
  }

  text(question: string, defaultValue: string): Promise<string> {
    return Promise.resolve(this.textAnswers[question] ?? defaultValue);
  }

  confirm(question: string, defaultValue: boolean): Promise<boolean> {
    this.confirmCalls.push(question);
    const next = this.confirmScript.shift();
    return Promise.resolve(next ?? defaultValue);
  }

  select<T extends string>(_question: string, _choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    return Promise.resolve(defaultValue);
  }

  secret(_question: string): Promise<string> {
    return Promise.resolve(this.secretAnswer);
  }

  multiSelect<T extends string>(_question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    if (this.multiSelectResult) return Promise.resolve(this.multiSelectResult as T[]);
    return Promise.resolve(choices.filter((choice) => choice.checked).map((choice) => choice.value));
  }

  close(): void {
    // no-op
  }
}

class RecordingRunner implements Runner {
  calls: Array<{ bin: string; argv: string[] }> = [];
  marketplaceRegistered = false;
  pluginInstalled = false;
  private readonly missing: Set<string>;
  private readonly failing: Set<string>;

  constructor(options: { missing?: string[]; failing?: string[] } = {}) {
    this.missing = new Set(options.missing ?? []);
    this.failing = new Set(options.failing ?? []);
  }

  run(bin: string, argv: string[]): Promise<number> {
    this.calls.push({ bin, argv });
    return Promise.resolve(this.failing.has(bin) ? 1 : 0);
  }

  capture(bin: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ bin, argv });
    const stdout =
      (this.marketplaceRegistered &&
        argv[0] === "plugin" &&
        argv[1] === "marketplace" &&
        argv[2] === "list" &&
        "foreman\n") ||
      (this.pluginInstalled && argv[0] === "plugin" && argv[1] === "list" && "foreman@foreman\n") ||
      "";
    return Promise.resolve({ code: this.failing.has(bin) ? 1 : 0, stdout, stderr: "" });
  }

  exists(bin: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(bin));
  }
}

function baseOptions(overrides: Partial<WizardOptions>, home: string, repoRoot: string): WizardOptions {
  return {
    home,
    repoRoot,
    githubRepo: "andyhite/foreman",
    scope: "user",
    ompMode: null,
    skipBuild: false,
    skipLinear: true,
    ...overrides,
  };
}

describe("runWizard", () => {
  it("links the omp plugin and builds first", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner();
      const logs: string[] = [];
      await runWizard(baseOptions({ ompMode: "link" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner,
        log: (message) => logs.push(message),
      });

      const binSeq = runner.calls.map((call) => `${call.bin} ${call.argv.join(" ")}`);
      expect(binSeq).toContain("bun install");
      expect(binSeq).toContain("bun run build");
      expect(binSeq).toContain("omp plugin link /repo/packages/omp-plugin --scope user");

      const configPath = join(home, ".foreman", "config.json");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("links the foreman CLI to source in dev mode, on top of the omp plugin", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      await runWizard(baseOptions({ ompMode: "link" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: () => {
          // discard
        },
      });

      const binPath = join(cliBinDir(home), "foreman");
      const contents = readFileSync(binPath, "utf8");
      expect(contents).toContain("exec bun");
      expect(contents).toContain("/repo/packages/cli/src/main.ts");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not link the foreman CLI when installing from GitHub", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      await runWizard(baseOptions({ ompMode: "install" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: () => {
          // discard
        },
      });

      expect(existsSync(join(cliBinDir(home), "foreman"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs from GitHub and skips the local build", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner();
      await runWizard(baseOptions({ ompMode: "install" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner,
        log: () => {
          // discard
        },
      });

      const binSeq = runner.calls.map((call) => `${call.bin} ${call.argv.join(" ")}`);
      expect(binSeq).not.toContain("bun install");
      expect(binSeq).not.toContain("bun run build");
      expect(binSeq).toContain("omp plugin marketplace add andyhite/foreman");
      expect(binSeq).toContain("omp plugin install foreman@foreman --scope user");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips marketplace add when the foreman marketplace is already registered", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner();
      runner.marketplaceRegistered = true;
      await runWizard(baseOptions({ ompMode: "install" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner,
        log: () => {},
      });

      const binSeq = runner.calls.map((call) => `${call.bin} ${call.argv.join(" ")}`);
      expect(binSeq).toContain("omp plugin marketplace list");
      expect(binSeq).not.toContain("omp plugin marketplace add andyhite/foreman");
      expect(binSeq).toContain("omp plugin install foreman@foreman --scope user");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("links the foreman CLI even when omp isn't installed", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const logs: string[] = [];
      await runWizard(baseOptions({ ompMode: "link" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner({ missing: ["omp"] }),
        log: (message) => logs.push(message),
      });

      expect(existsSync(join(cliBinDir(home), "foreman"))).toBe(true);
      expect(logs.some((line) => line.includes("omp is not installed"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws when the omp plugin link command fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner({ failing: ["omp"] });
      await expect(
        runWizard(baseOptions({ ompMode: "link", skipBuild: true }, home, "/repo"), {
          prompter: new ScriptedPrompter(),
          runner,
          log: () => {
            // discard
          },
        }),
      ).rejects.toThrow(/omp plugin link failed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves the Linear API key from the environment without prompting, and writes no repos key", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";

    try {
      const prompter = new ScriptedPrompter();
      await runWizard(
        baseOptions({ ompMode: "skip", skipLinear: false, skipBuild: true }, home, "/repo"),
        { prompter, runner: new RecordingRunner(), log: () => {} },
      );

      expect(prompter.confirmCalls).not.toContain("Do you have a Linear personal API key to configure now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toBeUndefined();
      expect(config.linear?.apiKeyFile ?? null).toBeNull();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prompts for and writes the Linear API key when not skipped and no env var is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    try {
      const prompter = new ScriptedPrompter([false]);
      await runWizard(
        baseOptions({ ompMode: "skip", skipLinear: false, skipBuild: true }, home, "/repo"),
        { prompter, runner: new RecordingRunner(), log: () => {} },
      );

      expect(prompter.confirmCalls).toContain("Do you have a Linear personal API key to configure now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toBeUndefined();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a whitespace-only Linear API key without writing a key file", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.secretAnswer = "   ";
      const logs: string[] = [];
      await runWizard(
        baseOptions({ ompMode: "skip", skipLinear: false, skipBuild: true }, home, "/repo"),
        { prompter, runner: new RecordingRunner(), log: (message) => logs.push(message) },
      );

      expect(logs.some((line) => line.includes("no key entered"))).toBe(true);
      expect(() => readFileSync(join(home, ".foreman", "linear-api-key"), "utf8")).toThrow();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips the plugin when omp is absent and explains why", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner({ missing: ["omp"] });
      const logs: string[] = [];
      await runWizard(baseOptions({ ompMode: "link" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner,
        log: (message) => logs.push(message),
      });

      expect(runner.calls.map((call) => call.bin)).not.toContain("omp");
      expect(runner.calls.map((call) => call.bin)).not.toContain("bun");
      expect(logs.some((line) => line.includes("omp is not installed") && line.includes("skipped"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("closing message names `foreman init` as the next step, not `foreman loop`", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const logs: string[] = [];
      await runWizard(baseOptions({ ompMode: "skip" }, home, "/repo"), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(logs.some((line) => line.includes("foreman init"))).toBe(true);
      expect(logs.some((line) => line.includes("foreman loop"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
