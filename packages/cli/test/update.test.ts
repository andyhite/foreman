import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateRepoPlugin,
  checkoutPluginDir,
  inspectRepoActivation,
  repoPluginLinkPath,
  writeGlobalPluginLink,
} from "../src/plugin-activation.ts";
import type { Runner } from "../src/exec.ts";
import { runUpdate, type UpdateOptions } from "../src/update.ts";

/**
 * Records every command issued, in order, and lets each test script a
 * response per command keyed on `bin` plus the argv joined with spaces
 * (matched by prefix). Defaults represent the healthy path: git checkout is
 * clean and up to date, and bun is present and succeeds.
 */
class RecordingRunner implements Runner {
  calls: Array<{ bin: string; argv: string[]; cwd?: string }> = [];
  private readonly missing: Set<string>;
  private readonly responses: Map<string, { code: number; stdout: string; stderr: string }>;

  constructor(
    options: {
      missing?: string[];
      responses?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
    } = {},
  ) {
    this.missing = new Set(options.missing ?? []);
    this.responses = new Map();
    for (const [key, value] of Object.entries(options.responses ?? {})) {
      this.responses.set(key, { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "" });
    }
  }

  private resolve(bin: string, argv: string[]): { code: number; stdout: string; stderr: string } {
    const full = `${bin} ${argv.join(" ")}`;
    for (const [key, value] of this.responses) {
      if (full === key || full.startsWith(`${key} `)) return value;
    }
    return this.defaultResponse(bin, argv);
  }

  private defaultResponse(bin: string, argv: string[]): { code: number; stdout: string; stderr: string } {
    if (bin === "git" && argv.join(" ") === "rev-parse --git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
    if (bin === "git" && argv.join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
    if (bin === "git" && argv.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (bin === "git" && argv.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "deadbeef\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  run(bin: string, argv: string[], options?: { cwd?: string }): Promise<number> {
    this.calls.push({ bin, argv, cwd: options?.cwd });
    return Promise.resolve(this.resolve(bin, argv).code);
  }

  capture(bin: string, argv: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ bin, argv, cwd: options?.cwd });
    return Promise.resolve(this.resolve(bin, argv));
  }

  exists(bin: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(bin));
  }
}

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-update-"));
}

function writeConfig(home: string, repos: Record<string, { path: string }>): void {
  const configDir = join(home, ".foreman");
  mkdirSync(configDir, { recursive: true });
  const withInitiatives = Object.fromEntries(
    Object.entries(repos).map(([alias, repo]) => [alias, { ...repo, initiatives: [`i-${alias}`] }]),
  );
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ repos: withInitiatives }));
}

function baseOptions(overrides: Partial<UpdateOptions>, home: string, checkoutRoot: string): UpdateOptions {
  return { checkoutRoot, home, skipPull: false, skipPlugin: false, ...overrides };
}

/** Builds a checkout with a buildable, versioned plugin package at `packages/omp-plugin`. */
function makeCheckout(root: string): void {
  const pluginDir = checkoutPluginDir(root);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "@foreman/omp-plugin", version: "1.2.3" }));
}

describe("runUpdate", () => {
  it("pulls, installs, and builds in order", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      makeCheckout(checkoutRoot);
      writeConfig(home, {});
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const order = runner.calls.map((call) => `${call.bin} ${call.argv[0]}`);
      const pullIndex = order.indexOf("git pull");
      const installIndex = order.indexOf("bun install");
      const buildIndex = order.findIndex((entry, i) => entry === "bun run" && runner.calls[i]!.argv[1] === "build");
      expect(pullIndex).toBeGreaterThanOrEqual(0);
      expect(installIndex).toBeGreaterThan(pullIndex);
      expect(buildIndex).toBeGreaterThan(installIndex);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--skip-pull skips git but still rebuilds", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      makeCheckout(checkoutRoot);
      writeConfig(home, {});
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({ skipPull: true }, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const gitCalls = runner.calls.filter((call) => call.bin === "git");
      expect(gitCalls).toHaveLength(0);
      const installCalls = runner.calls.filter((call) => call.bin === "bun" && call.argv[0] === "install");
      const buildCalls = runner.calls.filter((call) => call.bin === "bun" && call.argv.join(" ") === "run build");
      expect(installCalls).toHaveLength(1);
      expect(buildCalls).toHaveLength(1);
      expect(log.some((line) => line.includes("skipped the pull"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dirty tree refuses to pull but still rebuilds", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      makeCheckout(checkoutRoot);
      writeConfig(home, {});
      const runner = new RecordingRunner({
        responses: { "git status --porcelain": { stdout: " M src/update.ts\n" } },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const pullCalls = runner.calls.filter((call) => call.bin === "git" && call.argv[0] === "pull");
      expect(pullCalls).toHaveLength(0);
      const installCalls = runner.calls.filter((call) => call.bin === "bun" && call.argv[0] === "install");
      const buildCalls = runner.calls.filter((call) => call.bin === "bun" && call.argv.join(" ") === "run build");
      expect(installCalls).toHaveLength(1);
      expect(buildCalls).toHaveLength(1);
      expect(log.some((line) => line.includes("uncommitted changes"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-asserts the global link after rebuilding", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      makeCheckout(checkoutRoot);
      writeConfig(home, {});
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const globalLink = join(home, ".foreman", "plugin");
      expect(lstatSync(globalLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(globalLink)).toBe(checkoutPluginDir(checkoutRoot));
      expect(log.some((line) => line.includes(".foreman/plugin"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("repairs a registered repo whose activation drifted", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      makeCheckout(checkoutRoot);
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });

      // Activate once so the lock exists, then delete the symlink to simulate drift.

      writeGlobalPluginLink(checkoutRoot, home);
      activateRepoPlugin(repoA, home);
      unlinkSync(repoPluginLinkPath(repoA));

      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });


      expect(inspectRepoActivation(repoA, home).active).toBe(true);
      expect(log.some((line) => line.includes("a — repaired"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("warns about a repo whose path is gone without aborting the others", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    const repoB = join(home, "repos", "b");
    try {
      makeCheckout(checkoutRoot);
      mkdirSync(repoB, { recursive: true });
      writeConfig(home, { a: { path: repoA }, b: { path: repoB } });

      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(log.some((line) => line.includes("a") && line.includes("no longer exists"))).toBe(true);
      expect(inspectRepoActivation(repoB, home).active).toBe(true);
      expect(log.some((line) => line.includes("b —"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--skip-plugin leaves the global link and every repo untouched", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      makeCheckout(checkoutRoot);
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });

      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({ skipPlugin: true }, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(existsSync(join(home, ".foreman", "plugin"))).toBe(false);
      expect(inspectRepoActivation(repoA, home).active).toBe(false);
      expect(log.some((line) => line.includes("skipped") && line.includes("skip-plugin"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
