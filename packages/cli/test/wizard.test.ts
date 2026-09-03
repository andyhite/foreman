import { globalPluginLinkPath, PLUGIN_PACKAGE_NAME } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    return Promise.resolve({ code: this.failing.has(bin) ? 1 : 0, stdout: "", stderr: "" });
  }

  exists(bin: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(bin));
  }
}

function baseOptions(overrides: Partial<WizardOptions>, home: string, checkoutRoot: string): WizardOptions {
  return {
    home,
    checkoutRoot,
    linkCli: false,
    skipLinear: true,
    ...overrides,
  };
}

/** A minimal checkout: just enough for `writeGlobalPluginLink` to accept it. */
function makeCheckout(): string {
  const checkoutRoot = mkdtempSync(join(tmpdir(), "foreman-checkout-"));
  const pluginDir = join(checkoutRoot, "packages", "omp-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: PLUGIN_PACKAGE_NAME, version: "1.2.3" }));
  return checkoutRoot;
}

describe("runWizard", () => {
  it("writes the global plugin link pointed at the checkout's plugin package", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: () => {},
      });

      const linkPath = globalPluginLinkPath(home);
      expect(readlinkSync(linkPath)).toBe(join(checkoutRoot, "packages", "omp-plugin"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("is idempotent — re-running reports the link as already correct without rewriting it", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      const run = () =>
        runWizard(baseOptions({}, home, checkoutRoot), {
          prompter: new ScriptedPrompter(),
          runner: new RecordingRunner(),
          log: () => {},
        });
      await run();
      const linkPath = globalPluginLinkPath(home);
      const targetBefore = readlinkSync(linkPath);

      const logs: string[] = [];
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(readlinkSync(linkPath)).toBe(targetBefore);
      expect(logs.some((line) => line.includes("already points at"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("detects and removes a seeded machine-wide (user-scope) install", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      const userPluginRoot = join(home, ".omp", "plugins");
      mkdirSync(userPluginRoot, { recursive: true });
      writeFileSync(
        join(userPluginRoot, "omp-plugins.lock.json"),
        JSON.stringify({
          plugins: { [PLUGIN_PACKAGE_NAME]: { version: "1.0.0", enabledFeatures: null, enabled: true } },
          settings: {},
        }),
      );
      const userLinkDir = join(userPluginRoot, "node_modules", "@foreman");
      mkdirSync(userLinkDir, { recursive: true });
      symlinkSync(checkoutRoot, join(userLinkDir, "omp-plugin"));

      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter: new ScriptedPrompter([true]),
        runner: new RecordingRunner(),
        log: () => {},
      });

      const lock = JSON.parse(readFileSync(join(userPluginRoot, "omp-plugins.lock.json"), "utf8"));
      expect(lock.plugins[PLUGIN_PACKAGE_NAME]).toBeUndefined();
      expect(existsSync(join(userLinkDir, "omp-plugin"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("never calls omp", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      const runner = new RecordingRunner();
      await runWizard(baseOptions({ linkCli: true }, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner,
        log: () => {},
      });

      expect(runner.calls.map((call) => call.bin)).not.toContain("omp");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("links the foreman CLI to source when --link is passed", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      await runWizard(baseOptions({ linkCli: true }, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: () => {},
      });

      const binPath = join(cliBinDir(home), "foreman");
      const contents = readFileSync(binPath, "utf8");
      expect(contents).toContain("exec bun");
      expect(contents).toContain(`${checkoutRoot}/packages/cli/src/main.ts`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("does not link the foreman CLI without --link", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      await runWizard(baseOptions({ linkCli: false }, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: () => {},
      });

      expect(existsSync(join(cliBinDir(home), "foreman"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("resolves the Linear API key from the environment without prompting, and writes no repos key", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";

    try {
      const prompter = new ScriptedPrompter();
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: () => {},
      });

      expect(prompter.confirmCalls).not.toContain("Do you have a Linear personal API key to configure now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toBeUndefined();
      expect(config.linear?.apiKeyFile ?? null).toBeNull();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("prompts for and writes the Linear API key when not skipped and no env var is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    try {
      const prompter = new ScriptedPrompter([false]);
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: () => {},
      });

      expect(prompter.confirmCalls).toContain("Do you have a Linear personal API key to configure now?");
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.repos).toBeUndefined();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("rejects a whitespace-only Linear API key without writing a key file", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.secretAnswer = "   ";
      const logs: string[] = [];
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(logs.some((line) => line.includes("no key entered"))).toBe(true);
      expect(() => readFileSync(join(home, ".foreman", "linear-api-key"), "utf8")).toThrow();
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("resolves the operator's Linear user id from an email and writes it to operatorUserId", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("query UserByEmail")) {
        return new Response(
          JSON.stringify({ data: { users: { nodes: [{ id: "user-1", name: "Andy", displayName: "Andy Hite", email: "andy@example.com" }] } } }),
        );
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.textAnswers["Your Linear account email"] = "andy@example.com";
      const logs: string[] = [];
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.linear.operatorUserId).toBe("user-1");
      expect(logs.some((line) => line.includes("Andy Hite"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("warns and leaves operatorUserId unset when no Linear user matches the email", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { users: { nodes: [] } } }))) as unknown as typeof fetch;
    const originalEnvKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.textAnswers["Your Linear account email"] = "nobody@example.com";
      const logs: string[] = [];
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.linear?.operatorUserId).toBeUndefined();
      expect(logs.some((line) => line.includes("no Linear user found"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("skips the operator email prompt entirely with no Linear API key configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const prompter = new ScriptedPrompter([false]);
      await runWizard(baseOptions({ skipLinear: false }, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: () => {},
      });

      expect(prompter.confirmCalls).not.toContain(
        "Configure your Linear account email so blocked issues get assigned to you instead of left unowned?",
      );
    } finally {
      if (originalEnvKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalEnvKey;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("skips the GitHub App prompt without writing githubApp when declined", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      const prompter = new ScriptedPrompter([false]);
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: () => {},
      });

      expect(prompter.confirmCalls).toContain(
        "Configure a GitHub App so foreman-review can submit real PR reviews (approve/request changes), instead of Linear-comment-only advisory notes?",
      );
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.githubApp).toBeUndefined();
      expect(existsSync(join(home, ".foreman", "github-app-private-key.pem"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("warns and writes nothing when the GitHub App credentials fail to verify", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.textAnswers["GitHub App ID"] = "12345";
      prompter.secretAnswer = "not-a-real-key";
      const logs: string[] = [];
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(logs.some((line) => line.includes("couldn't verify the App credentials"))).toBe(true);
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.githubApp).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("verifies and writes the GitHub App id and private key file", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/app")) {
        return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;
    try {
      const prompter = new ScriptedPrompter([true]);
      prompter.textAnswers["GitHub App ID"] = "999";
      prompter.secretAnswer = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
      const logs: string[] = [];
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter,
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(logs.some((line) => line.includes("Foreman Review"))).toBe(true);
      const config = JSON.parse(readFileSync(join(home, ".foreman", "config.json"), "utf8"));
      expect(config.githubApp.appId).toBe("999");
      const keyPath = join(home, ".foreman", "github-app-private-key.pem");
      expect(config.githubApp.privateKeyFile).toBe(keyPath);
      expect(readFileSync(keyPath, "utf8")).toContain("BEGIN RSA PRIVATE KEY");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });

  it("closing message names `foreman init` as the next step, not `foreman repo`", async () => {
    const home = mkdtempSync(join(tmpdir(), "foreman-wizard-"));
    const checkoutRoot = makeCheckout();
    try {
      const logs: string[] = [];
      await runWizard(baseOptions({}, home, checkoutRoot), {
        prompter: new ScriptedPrompter(),
        runner: new RecordingRunner(),
        log: (message) => logs.push(message),
      });

      expect(logs.some((line) => line.includes("foreman init"))).toBe(true);
      expect(logs.some((line) => line.includes("foreman repo"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(checkoutRoot, { recursive: true, force: true });
    }
  });
});
