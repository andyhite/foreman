import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoEntry, loadGlobalConfig } from "../src/config/index.ts";
import { ConfigError } from "../src/config/load.ts";
import { PRIORITY } from "../src/domain/priority.ts";
import type { LinearReader } from "../src/linear/api.ts";
import type { Issue, WorkflowState } from "../src/linear/types.ts";
import { assertIssueInScope, issueScope } from "../src/repo.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };

/** Builds a dispatch-ready issue; tests override fields per case. */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: null,
    priority: PRIORITY.Medium,
    estimate: 2,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_TODO,
    labels: [],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "project-1", name: "Milestone" },
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "foreman-repo-"));
}

function writeGlobalConfig(home: string, contents: unknown): void {
  const dir = join(home, ".foreman");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(contents), "utf8");
}

describe("issueScope", () => {
  it("is in scope when the issue's initiative is bound to the entry", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-1", name: "Plotroom" }),
      };
      const verdict = await issueScope({ linear, entry }, makeIssue());
      expect(verdict).toEqual({ inScope: true, reason: null, initiativeId: "init-1", message: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives reason 'no-project' for a projectless issue", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-1", name: "Plotroom" }),
      };
      const verdict = await issueScope({ linear, entry }, makeIssue({ project: null }));
      expect(verdict.inScope).toBe(false);
      expect(verdict.reason).toBe("no-project");
      expect(verdict.message).toMatch(/ENG-1/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives reason 'initiative-unbound' when the issue's initiative is not in the entry's set", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-other", name: "Other" }),
      };
      const verdict = await issueScope({ linear, entry }, makeIssue());
      expect(verdict.inScope).toBe(false);
      expect(verdict.reason).toBe("initiative-unbound");
      expect(verdict.initiativeId).toBe("init-other");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("assertIssueInScope", () => {
  it("throws ConfigError naming the issue when it has no project", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-1", name: "Plotroom" }),
      };
      await expect(
        assertIssueInScope({ linear, entry }, makeIssue({ project: null })),
      ).rejects.toThrow(ConfigError);
      await expect(
        assertIssueInScope({ linear, entry }, makeIssue({ project: null })),
      ).rejects.toThrow(/ENG-1/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the entry when the issue's initiative is unbound", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", initiatives: ["init-1"] } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-other", name: "Other" }),
      };
      await expect(assertIssueInScope({ linear, entry }, makeIssue())).rejects.toThrow(ConfigError);
      await expect(assertIssueInScope({ linear, entry }, makeIssue())).rejects.toThrow(/plotroom/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
