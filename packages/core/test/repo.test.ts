import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoEntry, loadGlobalConfig } from "../src/config/index.ts";
import { ConfigError } from "../src/config/load.ts";
import { PRIORITY } from "../src/domain/priority.ts";
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
  it("is in scope when the issue's team matches the entry's bound team", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const verdict = issueScope(entry, makeIssue());
      expect(verdict).toEqual({ inScope: true, reason: null, message: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is in scope for a projectless issue on the right team", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const verdict = issueScope(entry, makeIssue({ project: null }));
      expect(verdict).toEqual({ inScope: true, reason: null, message: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives reason 'team-mismatch' with a message naming both team keys when the issue's team differs", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "OPS" } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const verdict = issueScope(entry, makeIssue({ team: { id: "team-1", key: "ENG", name: "Engineering" } }));
      expect(verdict.inScope).toBe(false);
      expect(verdict.reason).toBe("team-mismatch");
      expect(verdict.message).toContain("ENG");
      expect(verdict.message).toContain("OPS");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("assertIssueInScope", () => {
  it("does not throw for an in-scope issue", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "ENG" } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      expect(() => assertIssueInScope(entry, makeIssue())).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws ConfigError naming the entry and the issue's team when out of scope", () => {
    const home = makeHome();
    try {
      writeGlobalConfig(home, {
        repos: { plotroom: { path: "~/code/plotroom", team: "OPS" } },
      });
      const { config } = loadGlobalConfig({ home });
      const entry = resolveRepoEntry(config, "plotroom", home);
      const issue = makeIssue({ team: { id: "team-1", key: "ENG", name: "Engineering" } });
      expect(() => assertIssueInScope(entry, issue)).toThrow(ConfigError);
      expect(() => assertIssueInScope(entry, issue)).toThrow(/plotroom/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
