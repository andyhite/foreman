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
    herdrMode: null,
    skipBuild: false,
    skipLinear: true,
    ...overrides,
  };
}

describe("runWizard", () => {
  it("links the omp plugin, skips herdr when not installed, and builds first", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner({ missing: ["herdr"] });
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
      expect(binSeq.some((entry) => entry.startsWith("herdr"))).toBe(false);
      expect(logs.some((line) => line.includes("herdr is not on PATH"))).toBe(false);

      const configPath = join(home, ".foreman", "config.json");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs from GitHub for both plugins and skips the local build", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    try {
      const runner = new RecordingRunner();
      await runWizard(baseOptions({ ompMode: "install", herdrMode: "install" }, home, "/repo"), {
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
      expect(binSeq).toContain("herdr plugin install andyhite/foreman/packages/herdr-plugin");
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

  it("uses $LINEAR_API_KEY from the environment without prompting, and maps initiatives picked via the Linear API", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const originalFetch = globalThis.fetch;
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("query Initiatives")) {
        return new Response(JSON.stringify({ data: { initiatives: { nodes: [{ id: "i1", name: "Plotroom" }] } } }));
      }
      if (query.includes("query Teams")) {
        return new Response(
          JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } } }),
        );
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;

    try {
      const prompter = new ScriptedPrompter();
      prompter.multiSelectResult = ["i1"];
      prompter.textAnswers['Repo path for "Plotroom"'] = "/repos/plotroom";

      await runWizard(
        baseOptions({ ompMode: "skip", herdrMode: "skip", skipLinear: false, skipBuild: true }, home, "/repo"),
        { prompter, runner: new RecordingRunner(), log: () => {} },
      );

      expect(prompter.confirmCalls).not.toContain("Do you have a Linear personal API key to configure now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toEqual({ i1: "/repos/plotroom" });
      expect(config.linear.teamKeys).toEqual(["ENG"]);
      expect(config.linear.apiKeyFile ?? null).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to manual initiative entry when the Linear API call fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const originalFetch = globalThis.fetch;
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    try {
      const prompter = new ScriptedPrompter([false]);
      await runWizard(
        baseOptions({ ompMode: "skip", herdrMode: "skip", skipLinear: false, skipBuild: true }, home, "/repo"),
        { prompter, runner: new RecordingRunner(), log: () => {} },
      );

      expect(prompter.confirmCalls).toContain("Map a Linear initiative id to a repo path now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
