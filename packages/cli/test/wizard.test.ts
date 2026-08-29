import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/exec.ts";
import type { Choice, CheckboxChoice, Prompter } from "../src/prompt.ts";
import { runWizard, type WizardOptions } from "../src/wizard.ts";

class ScriptedPrompter implements Prompter {
  confirmCalls: string[] = [];
  multiSelectResult: string[] | null = null;
  textAnswers: Record<string, string> = {};
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

class RecordingRunner implements Runner {
  calls: Array<{ bin: string; argv: string[] }> = [];
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
