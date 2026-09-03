import {
  activateRepoPlugin,
  groupDisplayName,
  MANAGED_LABEL_GROUP_PREFIXES,
  MANAGED_LABELS,
  MANAGED_STATES,
  repoPluginLinkPath,
  writeGlobalPluginLink,
} from "@foreman/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/exec.ts";
import { writeGlobalConfig, writeLinearApiKeyFile } from "../src/global-config.ts";
import { runDoctor, type DoctorOptions } from "../src/doctor.ts";

/** Always reports every probed binary as present, so tool checks never fail a test by accident. */
class FakeRunner implements Runner {
  private readonly missing: Set<string>;

  constructor(missing: string[] = []) {
    this.missing = new Set(missing);
  }

  run(): Promise<number> {
    return Promise.resolve(0);
  }

  capture(): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }

  exists(bin: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(bin));
  }
}

/** A `WorkspaceLabels` response reporting every managed group and member already present. */
function existingWorkspaceLabelsResponse(): Response {
  const nodes: Array<{ id: string; name: string; isGroup: boolean; parent: { id: string; name: string } | null }> = [];
  for (const prefix of MANAGED_LABEL_GROUP_PREFIXES) {
    const groupName = groupDisplayName(prefix);
    nodes.push({ id: `group-${groupName}`, name: groupName, isGroup: true, parent: null });
  }
  for (const id of MANAGED_LABELS) {
    const [prefix, child] = id.split(":") as [string, string];
    const groupName = groupDisplayName(`${prefix}:`);
    const childName = child
      .split("-")
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ");
    nodes.push({ id: `label-${id}`, name: childName, isGroup: false, parent: { id: `group-${groupName}`, name: groupName } });
  }
  return new Response(JSON.stringify({ data: { issueLabels: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
}

/**
 * Answers every `checkProvisioning` query as fully healthy for team `ENG`:
 * every managed workspace label present, triage on/cycles off, every
 * `MANAGED_STATES` name present, no `app:*` labels expected. Tests that
 * register a repo use team `ENG` so this single mock covers them all.
 */
function fullyProvisionedFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body ?? "{}")).query as string;
    if (query.includes("query WorkspaceLabels")) return existingWorkspaceLabelsResponse();
    if (query.includes("query Teams")) {
      return new Response(
        JSON.stringify({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      );
    }
    if (query.includes("query TeamSettings")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              id: "t1",
              key: "ENG",
              name: "Engineering",
              triageEnabled: true,
              cyclesEnabled: false,
              triageIssueState: { id: "triage-1", name: "Triage", type: "triage", position: 0 },
            },
          },
        }),
      );
    }
    if (query.includes("query TeamWorkflowStates")) {
      const nodes: Array<{ id: string; name: string; type: string; position: number; color: string; description: string | null }> = MANAGED_STATES.map((spec, index) => ({ id: `state-${index}`, name: spec.name, type: spec.type, position: spec.position, color: spec.color, description: spec.description }));
      nodes.push({ id: "state-duplicate", name: "Duplicate", type: "duplicate", position: 8, color: "#95a2b3", description: null });
      return new Response(JSON.stringify({ data: { team: { states: { nodes } } } }));
    }
    if (query.includes("query ProjectLabels")) {
      return new Response(JSON.stringify({ data: { projectLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    }
    throw new Error(`unexpected query in verify.test.ts fetch mock: ${query}`);
  }) as unknown as typeof fetch;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A temp home that already has a Linear credential configured.
 *
 * Every case below is about plugin activation, but `runDoctor` also reports a
 * missing credential as a problem — so a home without one can never return 0
 * and the activation assertions would be measuring the wrong thing. Seeding it
 * here keeps each test's exit code attributable to what that test changed.
 */
function makeHome(): string {
  const home = makeTempDir("foreman-doctor-home-");
  writeGlobalConfig({ linear: { apiKeyFile: writeLinearApiKeyFile("lin_api_fixture", home) } }, home);
  return home;
}

/*
 * `runDoctor` reads `$LINEAR_API_KEY`, so an ambient key in the developer's
 * shell would satisfy the credential check and hide a regression that CI —
 * where the variable is unset — would catch. Drop it for this file and put it
 * back afterwards, so the suite does not leak the change into other files.
 *
 * `checkProvisioning` now hits the Linear API on every `runDoctor` call once
 * a credential resolves, so `fetch` is stubbed here too — real network calls
 * are never exercised by this suite.
 */
const ambientApiKey = process.env.LINEAR_API_KEY;
const originalFetch = globalThis.fetch;
beforeAll(() => {
  delete process.env.LINEAR_API_KEY;
  globalThis.fetch = fullyProvisionedFetch();
});
afterAll(() => {
  if (ambientApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ambientApiKey;
  globalThis.fetch = originalFetch;
});

/** Builds a fixture checkout: `<checkoutRoot>/packages/omp-plugin` with a package.json. */
function makeFixtureCheckout(): string {
  const checkoutRoot = makeTempDir("foreman-doctor-checkout-");
  const pluginDir = join(checkoutRoot, "packages", "omp-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "@foreman/omp-plugin", version: "9.9.9" }));
  return checkoutRoot;
}

function makeGitRepo(): string {
  const repoRoot = makeTempDir("foreman-doctor-repo-");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  return repoRoot;
}

function baseOptions(home: string, overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return { home, checkoutRoot: null, fix: false, ...overrides };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

describe("runDoctor", () => {
  it("returns 0 when the machine is fully healthy and nothing is registered", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const log: string[] = [];

    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    expect(code).toBe(0);
    cleanup(home, checkoutRoot);
  });

  it("reports and fixes a missing global link", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    const deps = { runner: new FakeRunner(), log: () => {} };

    const before = await runDoctor(baseOptions(home, { checkoutRoot }), deps);
    expect(before).toBe(1);

    const after = await runDoctor(baseOptions(home, { checkoutRoot, fix: true }), deps);
    expect(after).toBe(0);

    cleanup(home, checkoutRoot);
  });

  it("reports and removes a seeded user-scope (machine-wide) install", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);

    const userRoot = join(home, ".omp", "plugins");
    mkdirSync(join(userRoot, "node_modules", "@foreman"), { recursive: true });
    symlinkSync(checkoutRoot, join(userRoot, "node_modules", "@foreman", "omp-plugin"));
    writeFileSync(
      join(userRoot, "omp-plugins.lock.json"),
      JSON.stringify({
        plugins: { "@foreman/omp-plugin": { version: "9.9.9", enabledFeatures: null, enabled: true } },
        settings: {},
      }),
    );

    const deps = { runner: new FakeRunner(), log: () => {} };
    const before = await runDoctor(baseOptions(home, { checkoutRoot }), deps);
    expect(before).toBe(1);

    const after = await runDoctor(baseOptions(home, { checkoutRoot, fix: true }), deps);
    expect(after).toBe(0);

    cleanup(home, checkoutRoot);
  });

  it("reports and reactivates a registered repo whose symlink was deleted", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    unlinkSync(repoPluginLinkPath(repoRoot));

    const deps = { runner: new FakeRunner(), log: () => {} };
    const before = await runDoctor(baseOptions(home, { checkoutRoot }), deps);
    expect(before).toBe(1);

    const after = await runDoctor(baseOptions(home, { checkoutRoot, fix: true }), deps);
    expect(after).toBe(0);

    cleanup(home, checkoutRoot, repoRoot);
  });

  it("reports 1 without throwing when a registered repo's path no longer exists", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const goneRoot = join(makeTempDir("foreman-doctor-gone-"), "does-not-exist");
    writeGlobalConfig({ repos: { gone: { path: goneRoot, team: "ENG" } } }, home);

    const deps = { runner: new FakeRunner(), log: () => {} };
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), deps);

    expect(code).toBe(1);
    cleanup(home, checkoutRoot);
  });

  it("reports 1 when no Linear credential is configured anywhere", async () => {
    const home = makeTempDir("foreman-doctor-home-");
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);

    const code = await runDoctor(baseOptions(home, { checkoutRoot }), {
      runner: new FakeRunner(),
      log: () => {},
    });

    expect(code).toBe(1);
    cleanup(home, checkoutRoot);
  });
});
