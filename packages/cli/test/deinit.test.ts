import { activateRepoPlugin, repoPluginLockPath, repoPluginRoot } from "@foreman/core";
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeinit, type DeinitDeps, type DeinitOptions } from "../src/deinit.ts";
import type { Choice, Prompter } from "../src/prompt.ts";

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
  return { cwd, home, keepRegistry: false, revertLinear: false, yes: false, ...overrides };
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

describe("runDeinit — --revert-linear", () => {
  function wireIssue(id: string, stateId: string, stateName: string): unknown {
    return {
      id,
      identifier: `ENG-${id}`,
      title: "An issue",
      description: null,
      priority: 0,
      estimate: null,
      url: `https://linear.app/issue/${id}`,
      branchName: `eng-${id}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      state: { id: stateId, name: stateName, type: "backlog" },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
      project: null,
      team: { id: "t1", key: "ENG", name: "Engineering" },
      assignee: null,
      parent: null,
      children: { nodes: [], pageInfo: { hasNextPage: false } },
      relations: { nodes: [], pageInfo: { hasNextPage: false } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    };
  }

  function seedRegistry(home: string, repoRoot: string): void {
    mkdirSync(join(home, ".foreman"), { recursive: true });
    writeFileSync(
      join(home, ".foreman", "config.json"),
      JSON.stringify({ repos: { plotroom: { path: repoRoot, team: "ENG" } } }),
    );
  }

  function seedApiKey(home: string): void {
    const keyPath = join(home, ".foreman", "linear-api-key");
    mkdirSync(join(home, ".foreman"), { recursive: true });
    writeFileSync(keyPath, "lin_api_test\n", { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const configPath = join(home, ".foreman", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.linear = { apiKeyFile: keyPath };
    writeFileSync(configPath, JSON.stringify(config));
  }

  it("without --revert-linear, makes no Linear request", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("no Linear request should be made without --revert-linear");
    }) as unknown as typeof fetch;
    try {
      seedRegistry(home, repoRoot);
      seedApiKey(home);

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      const logs: string[] = [];
      await runDeinit(baseOptions({ keepRegistry: true, revertLinear: false }, home, repoRoot), {
        prompter,
        git,
        log: (m) => logs.push(m),
      });

      expect(logs.some((line) => line.includes("skipped (pass --revert-linear"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("with --revert-linear and an empty managed state, archives it", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    const originalFetch = globalThis.fetch;
    let archiveCalls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("query Teams")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      if (query.includes("query TeamWorkflowStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [{ id: "s-backlog", name: "Backlog", type: "backlog", position: 0, color: "#000000", description: null }] } } } }),
        );
      }
      if (query.includes("query Issues")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      if (query.includes("mutation WorkflowStateArchive")) {
        archiveCalls += 1;
        return new Response(JSON.stringify({ data: { workflowStateArchive: { success: true } } }));
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;
    try {
      seedRegistry(home, repoRoot);
      seedApiKey(home);

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      const logs: string[] = [];
      await runDeinit(baseOptions({ keepRegistry: true, revertLinear: true, yes: true }, home, repoRoot), {
        prompter,
        git,
        log: (m) => logs.push(m),
      });

      expect(archiveCalls).toBe(1);
      expect(logs.some((line) => line.includes("Backlog"))).toBe(true);
      expect(logs.some((line) => line.includes("Left in place"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("with --revert-linear and a state holding an issue, does not archive it and names the count", async () => {
    const home = makeTempHome();
    const repoRoot = makeTempRepo();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("query Teams")) {
        return new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      if (query.includes("query TeamWorkflowStates")) {
        return new Response(
          JSON.stringify({ data: { team: { states: { nodes: [{ id: "s-backlog", name: "Backlog", type: "backlog", position: 0, color: "#000000", description: null }] } } } }),
        );
      }
      if (query.includes("query Issues")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [wireIssue("1", "s-backlog", "Backlog")], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as typeof fetch;
    try {
      seedRegistry(home, repoRoot);
      seedApiKey(home);

      const git = new FakeGit(repoRoot);
      const prompter = new ScriptedPrompter();
      const logs: string[] = [];
      await runDeinit(baseOptions({ keepRegistry: true, revertLinear: true, yes: true }, home, repoRoot), {
        prompter,
        git,
        log: (m) => logs.push(m),
      });

      expect(logs.some((line) => line.includes("still holds 1 issue(s)"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
