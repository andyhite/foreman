import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig } from "../src/config/index.ts";
import { ConfigError } from "../src/config/load.ts";
import { PRIORITY } from "../src/domain/priority.ts";
import type { LinearReader } from "../src/linear/api.ts";
import type { Issue, WorkflowState } from "../src/linear/types.ts";
import { repoForIssue } from "../src/repo.ts";

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

describe("repoForIssue", () => {
  it("resolves a mapped initiative to its repo path", async () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, { repos: { "init-1": "~/code/plotroom" } });
      const { config } = loadGlobalConfig({ home });
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-1", name: "Plotroom" }),
      };
      const path = await repoForIssue({ linear, config, home }, makeIssue());
      expect(path).toBe(join(home, "code", "plotroom"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the issue when it has no project", async () => {
    const home = makeHome();
    try {
      const { config } = loadGlobalConfig({ home });
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => ({ id: "init-1", name: "Plotroom" }),
      };
      await expect(
        repoForIssue({ linear, config, home }, makeIssue({ project: null })),
      ).rejects.toThrow(ConfigError);
      await expect(
        repoForIssue({ linear, config, home }, makeIssue({ project: null })),
      ).rejects.toThrow(/ENG-1/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates the ambiguity error from projectInitiative", async () => {
    const home = makeHome();
    try {
      const { config } = loadGlobalConfig({ home });
      const linear: Pick<LinearReader, "projectInitiative"> = {
        projectInitiative: async () => {
          throw new Error("project has 2 initiatives; expected exactly 1");
        },
      };
      await expect(repoForIssue({ linear, config, home }, makeIssue())).rejects.toThrow(
        /2 initiatives/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
