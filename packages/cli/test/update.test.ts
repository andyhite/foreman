import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/exec.ts";
import { runUpdate, type UpdateOptions } from "../src/update.ts";
import { OMP_PLUGIN_LIST_TABLE, ompPluginListJson } from "./omp-fixtures.ts";

/**
 * Records every command issued, in order, and lets each test script a
 * response per command keyed on `bin` plus the argv joined with spaces
 * (matched by prefix so e.g. "omp plugin upgrade" can be scripted without
 * repeating the trailing "foreman@foreman"). Defaults represent the healthy
 * path: git checkout is clean and up to date, bun/omp are present and
 * succeed, and `omp plugin list` reports the plugin project-installed.
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
    if (bin === "omp" && argv[0] === "plugin" && argv[1] === "list") {
      return { code: 0, stdout: ompPluginListJson(["project"]), stderr: "" };
    }
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

function ompUpgradeCalls(runner: RecordingRunner): Array<{ bin: string; argv: string[]; cwd?: string }> {
  return runner.calls.filter((call) => call.bin === "omp" && call.argv[0] === "plugin" && call.argv[1] === "upgrade");
}

function ompMarketplaceUpdateCalls(runner: RecordingRunner): Array<{ bin: string; argv: string[]; cwd?: string }> {
  return runner.calls.filter(
    (call) => call.bin === "omp" && call.argv[0] === "plugin" && call.argv[1] === "marketplace" && call.argv[2] === "update",
  );
}

describe("runUpdate", () => {
  it("upgrades marketplace before any repo, scoping each upgrade to its own cwd", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    const repoB = join(home, "repos", "b");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      writeConfig(home, { a: { path: repoA }, b: { path: repoB } });
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const marketplaceIndex = runner.calls.findIndex(
        (call) => call.bin === "omp" && call.argv[0] === "plugin" && call.argv[1] === "marketplace" && call.argv[2] === "update",
      );
      const upgradeIndexes = ompUpgradeCalls(runner).map((call) => runner.calls.indexOf(call));
      expect(marketplaceIndex).toBeGreaterThanOrEqual(0);
      expect(upgradeIndexes.length).toBeGreaterThan(0);
      for (const upgradeIndex of upgradeIndexes) {
        expect(marketplaceIndex).toBeLessThan(upgradeIndex);
      }
      const upgradeCwds = ompUpgradeCalls(runner).map((call) => call.cwd);
      expect(upgradeCwds).toContain(repoA);
      expect(upgradeCwds).toContain(repoB);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("upgrades every registered repo, not just one", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    const repoB = join(home, "repos", "b");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      writeConfig(home, { a: { path: repoA }, b: { path: repoB } });
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompUpgradeCalls(runner)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips git pull on a dirty checkout but still rebuilds", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
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

  it("runs no git pull with skipPull, but still rebuilds", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
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

  it("performs no omp commands at all with skipPlugin", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      writeConfig(home, {});
      const runner = new RecordingRunner();
      const log: string[] = [];

      await runUpdate(baseOptions({ skipPlugin: true }, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      const ompCalls = runner.calls.filter((call) => call.bin === "omp");
      expect(ompCalls).toHaveLength(0);
      expect(log.some((line) => line.includes("skipped") && line.includes("skip-plugin"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("attempts no repo upgrade when marketplace update fails", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });
      const runner = new RecordingRunner({
        responses: { "omp plugin marketplace update foreman": { code: 1 } },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompMarketplaceUpdateCalls(runner)).toHaveLength(1);
      expect(ompUpgradeCalls(runner)).toHaveLength(0);
      const listCalls = runner.calls.filter((call) => call.bin === "omp" && call.argv[0] === "plugin" && call.argv[1] === "list");
      expect(listCalls).toHaveLength(0);
      expect(log.some((line) => line.includes("marketplace update failed"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips a repo with no project scope in `omp plugin list`", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });
      const runner = new RecordingRunner({
        responses: { "omp plugin list": { stdout: ompPluginListJson(["user"]) } },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompUpgradeCalls(runner)).toHaveLength(0);
      expect(log.some((line) => line.includes("no project install"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports an unreadable plugin list as itself, not as a missing install", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });
      // The human table: exactly what a probe that lost `--json` returns,
      // and it reports a plugin that *is* installed. Sending the operator
      // to `foreman init` here is the failure mode being guarded.
      const runner = new RecordingRunner({
        responses: { "omp plugin list": { stdout: OMP_PLUGIN_LIST_TABLE } },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompUpgradeCalls(runner)).toHaveLength(0);
      expect(log.some((line) => line.includes("could not read"))).toBe(true);
      expect(log.some((line) => line.includes("no project install"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a zero-exit upgrade printing 'Failed to upgrade' as a failure", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });
      const runner = new RecordingRunner({
        responses: {
          "omp plugin upgrade foreman@foreman": { code: 0, stdout: "Failed to upgrade: cache missing\n" },
        },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompUpgradeCalls(runner)).toHaveLength(1);
      expect(log.some((line) => line.includes("upgrade failed") && line.includes("Failed to upgrade"))).toBe(true);
      expect(log.some((line) => line.includes("✓") && line.includes(" a — "))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a zero-exit upgrade printing '3 plugins, 0 failed' as a success", async () => {
    const home = makeTempHome();
    const checkoutRoot = join(home, "checkout");
    const repoA = join(home, "repos", "a");
    try {
      mkdirSync(checkoutRoot, { recursive: true });
      mkdirSync(repoA, { recursive: true });
      writeConfig(home, { a: { path: repoA } });
      const runner = new RecordingRunner({
        responses: {
          "omp plugin upgrade foreman@foreman": { code: 0, stdout: "3 plugins, 0 failed\n" },
        },
      });
      const log: string[] = [];

      await runUpdate(baseOptions({}, home, checkoutRoot), { runner, log: (m) => log.push(m) });

      expect(ompUpgradeCalls(runner)).toHaveLength(1);
      expect(log.some((line) => line.includes("upgrade failed"))).toBe(false);
      expect(log.some((line) => line.includes("✓") && line.includes(" a — "))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
