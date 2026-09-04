import {
  activateRepoPlugin,
  CONTEXT_DOC_TEMPLATE,
  CONTEXT_DOC_TITLE,
  groupDisplayName,
  MANAGED_LABEL_GROUP_PREFIXES,
  MANAGED_LABELS,
  MANAGED_STATES,
  repoPluginLinkPath,
  writeGlobalPluginLink,
} from "@foreman/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/exec.ts";
import { writeGlobalConfig, writeLinearApiKeyFile } from "../src/global-config.ts";
import { runDoctor, type DoctorOptions } from "../src/doctor.ts";

/*
 * `bun test` shares one process across files, so a test that swaps
 * `globalThis.fetch` and then fails its assertion never reaches its own
 * restore line, and the next file inherits a Linear mock that rejects its
 * URLs. That cascade turned one real `--fix` regression here into four
 * unrelated failures in `init.test.ts`.
 *
 * The snapshot is taken per test rather than once per file: `beforeAll`
 * hooks have already run by then, so a describe-level mock survives while
 * a per-test swap is always undone.
 */
let fetchAtTestStart: typeof globalThis.fetch;
beforeEach(() => {
  fetchAtTestStart = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = fetchAtTestStart;
});

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
    if (query.includes("query TeamDocuments")) {
      return new Response(
        JSON.stringify({
          data: {
            documents: {
              nodes: [{ id: "doc-1", title: "Context", content: "## Architectural decisions and constraints\n\nWe use a monorepo.\n", updatedAt: "2024-01-01T00:00:00.000Z" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
    }
    if (query.includes("query ProjectLabels")) {
      return new Response(JSON.stringify({ data: { projectLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    }
    throw new Error(`unexpected query in verify.test.ts fetch mock: ${query}`);
  }) as unknown as typeof fetch;
}

/** `fullyProvisionedFetch` with `query TeamDocuments` overridden, so individual tests can exercise a missing/stub/filled product `Context` doc without duplicating the rest of the healthy-team mock. */
function fetchWithContextDoc(documentsNodes: Array<{ id: string; title: string; content: string | null; updatedAt: string }>): typeof fetch {
  const base = fullyProvisionedFetch();
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body ?? "{}")).query as string;
    if (query.includes("query TeamDocuments")) {
      return new Response(JSON.stringify({ data: { documents: { nodes: documentsNodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
    }
    return base(url, init);
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
  writeFileSync(join(checkoutRoot, "package.json"), JSON.stringify({ name: "foreman" }));
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
  return { home, checkoutRoot: null, fix: false, yes: false, ...overrides };
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

  it("reports 1 with a readable message instead of throwing when config.json is malformed", async () => {
    const home = makeTempDir("foreman-doctor-home-");
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    mkdirSync(join(home, ".foreman"), { recursive: true });
    writeFileSync(join(home, ".foreman", "config.json"), JSON.stringify({ repos: { a: { path: "/tmp", team: 5 } } }), "utf8");

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    expect(code).toBe(1);
    expect(log.some((line) => line.includes("config.json is invalid"))).toBe(true);
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

  it("contains a repair error when the repo symlink location is a real directory, and still summarizes", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    mkdirSync(repoPluginLinkPath(repoRoot), { recursive: true });

    const log: string[] = [];
    const deps = { runner: new FakeRunner(), log: (m: string) => log.push(m) };
    const code = await runDoctor(baseOptions(home, { checkoutRoot, fix: true }), deps);

    expect(code).toBe(1);
    expect(log.some((line) => line.includes("could not repair"))).toBe(true);

    cleanup(home, checkoutRoot, repoRoot);
  });

  it("reports a missing product Context doc distinctly from a still-stub one", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const originalFetchForTest = globalThis.fetch;
    globalThis.fetch = fetchWithContextDoc([]);

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(code).toBe(1);
    expect(log.some((line) => line.includes(`no product "${CONTEXT_DOC_TITLE}" doc`))).toBe(true);

    cleanup(home, checkoutRoot, repoRoot);
  });

  it("reports an untouched seed stub product Context doc distinctly from a missing one", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const originalFetchForTest = globalThis.fetch;
    globalThis.fetch = fetchWithContextDoc([{ id: "doc-1", title: "Context", content: CONTEXT_DOC_TEMPLATE, updatedAt: "2024-01-01T00:00:00.000Z" }]);

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(code).toBe(1);
    expect(log.some((line) => line.includes("still the seed stub"))).toBe(true);

    cleanup(home, checkoutRoot, repoRoot);
  });

  /*
   * The defect this pins: `teamProvisioningIssues` is the `--fix` gate, and it
   * once omitted the Context doc. A team healthy on settings/states/labels
   * produced an empty list, `provisionTeam` never ran, and `--fix` printed
   * "run `foreman doctor --fix`" straight back at the operator.
   */
  it("seeds a missing product Context doc under --fix on a team with no other drift", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const originalFetchForTest = globalThis.fetch;
    const base = fullyProvisionedFetch();
    const created: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
      if (payload.query.includes("mutation DocumentCreate")) {
        created.push(payload.variables ?? {});
        return new Response(JSON.stringify({ data: { documentCreate: { success: true, document: { id: "doc-new" } } } }));
      }
      if (payload.query.includes("query TeamDocuments")) {
        // Absent until the mutation lands, so the gate's post-fix re-check
        // observes the repair rather than the original absence.
        const nodes =
          created.length > 0
            ? [{ id: "doc-new", title: CONTEXT_DOC_TITLE, content: CONTEXT_DOC_TEMPLATE, updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [];
        return new Response(JSON.stringify({ data: { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      return base(url, init);
    }) as typeof fetch;

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot, fix: true, yes: true }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ input: { title: CONTEXT_DOC_TITLE, content: CONTEXT_DOC_TEMPLATE } });
    // The seeded doc is a stub, which is a real remaining problem - but one
    // only the operator can resolve, so `--fix` must not re-advise itself.
    expect(code).toBe(1);
    expect(log.some((line) => line.includes(`no product "${CONTEXT_DOC_TITLE}" doc`))).toBe(false);
    expect(log.some((line) => line.includes("still the seed stub"))).toBe(true);
    expect(log.some((line) => line.includes("run `foreman doctor --fix`"))).toBe(false);

    cleanup(home, checkoutRoot, repoRoot);
  });

  /*
   * Linear rewrites `_italic_` to `*italic*` on write, so the stored body is
   * never byte-identical to the seed. A doctor that only matched the template
   * verbatim called a fresh stub "filled in" - measured live, not theorised.
   */
  it("detects a seed stub whose emphasis Linear rewrote to asterisks", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const asStoredByLinear = CONTEXT_DOC_TEMPLATE.replace(/^_(.+)_$/gm, "*$1*").trimEnd();
    expect(asStoredByLinear).not.toContain("_Record");

    const originalFetchForTest = globalThis.fetch;
    globalThis.fetch = fetchWithContextDoc([
      { id: "doc-1", title: CONTEXT_DOC_TITLE, content: asStoredByLinear, updatedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(code).toBe(1);
    expect(log.some((line) => line.includes("still the seed stub"))).toBe(true);
    expect(log.some((line) => line.includes("is filled in"))).toBe(false);
    // A stub is operator-only work, so a plain run must not close by advising
    // `--fix`, which has no repair for it.
    expect(log.some((line) => line.includes("run `foreman doctor --fix`"))).toBe(false);

    cleanup(home, checkoutRoot, repoRoot);
  });

  it("honours a configured linear.apiKeyEnv for the credential check", async () => {
    const home = makeTempDir("foreman-doctor-home-");
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const keyFile = writeLinearApiKeyFile("lin_api_fixture", home);
    writeFileSync(join(home, ".foreman", "config.json"), JSON.stringify({ linear: { apiKeyEnv: "MY_KEY", apiKeyFile: keyFile } }), "utf8");
    process.env.MY_KEY = "lin_api_fixture";

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    delete process.env.MY_KEY;

    expect(code).toBe(0);
    expect(log.some((line) => line.includes("MY_KEY set in environment"))).toBe(true);
    cleanup(home, checkoutRoot);
  });

  it("reports a problem when the credential env var is set but the configured apiKeyFile is missing", async () => {
    const home = makeTempDir("foreman-doctor-home-");
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const missingFile = join(home, ".foreman", "does-not-exist");
    mkdirSync(join(home, ".foreman"), { recursive: true });
    writeFileSync(join(home, ".foreman", "config.json"), JSON.stringify({ linear: { apiKeyFile: missingFile } }), "utf8");
    process.env.LINEAR_API_KEY = "lin_api_fixture";

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    delete process.env.LINEAR_API_KEY;

    expect(code).toBe(1);
    expect(log.some((line) => line.includes("linear.apiKeyFile is") && line.includes("cannot pass the credential"))).toBe(true);
    cleanup(home, checkoutRoot);
  });

  /*
   * `provisionTeam` archives operator-created workflow states; passing
   * `YOLO_CONFIRMER` unconditionally under `--fix` meant a repair command
   * could destroy them with no prompt. `process.stdin.isTTY` is falsy under
   * `bun test`, so this pins the non-TTY, no-`--yes` skip path: `--fix`
   * reports the skip instead of quietly repairing (or quietly failing to).
   */
  it("skips the Linear provisioning repair under --fix with no --yes and no terminal", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const originalFetchForTest = globalThis.fetch;
    let provisionCalls = 0;
    const base = fullyProvisionedFetch();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (payload.query.includes("mutation DocumentCreate")) provisionCalls += 1;
      if (payload.query.includes("query TeamDocuments")) {
        return new Response(JSON.stringify({ data: { documents: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      return base(url, init);
    }) as typeof fetch;

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot, fix: true }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(code).toBe(1);
    expect(provisionCalls).toBe(0);
    expect(log.some((line) => line.includes("no terminal to confirm on") && line.includes("--yes"))).toBe(true);

    cleanup(home, checkoutRoot, repoRoot);
  });

  it("runs the Linear provisioning repair under --fix --yes", async () => {
    const home = makeHome();
    const checkoutRoot = makeFixtureCheckout();
    writeGlobalPluginLink(checkoutRoot, home);
    const repoRoot = makeGitRepo();
    activateRepoPlugin(repoRoot, home);
    writeGlobalConfig({ repos: { fixture: { path: repoRoot, team: "ENG" } } }, home);

    const originalFetchForTest = globalThis.fetch;
    const base = fullyProvisionedFetch();
    let created = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      if (payload.query.includes("mutation DocumentCreate")) {
        created += 1;
        return new Response(JSON.stringify({ data: { documentCreate: { success: true, document: { id: "doc-new" } } } }));
      }
      if (payload.query.includes("query TeamDocuments")) {
        const nodes =
          created > 0
            ? [{ id: "doc-new", title: CONTEXT_DOC_TITLE, content: CONTEXT_DOC_TEMPLATE, updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [];
        return new Response(JSON.stringify({ data: { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }));
      }
      return base(url, init);
    }) as typeof fetch;

    const log: string[] = [];
    const code = await runDoctor(baseOptions(home, { checkoutRoot, fix: true, yes: true }), { runner: new FakeRunner(), log: (m) => log.push(m) });

    globalThis.fetch = originalFetchForTest;

    expect(created).toBe(1);
    expect(log.some((line) => line.includes("no terminal to confirm on"))).toBe(false);
    expect(code).toBe(1);

    cleanup(home, checkoutRoot, repoRoot);
  });
});
