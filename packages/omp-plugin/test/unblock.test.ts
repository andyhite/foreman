import { describe, expect, it } from "bun:test";
import { FOREMAN_LABEL, PRIORITY, TYPE_LABEL } from "@foreman/core";
import type { Comment, CreateIssueInput, Issue, IssueLabel, IssueMutation, LinearWriter, ProjectRef, WorkflowState } from "@foreman/core";
import { runUnblock } from "../src/commands/unblock.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };

function label(name: string): IssueLabel {
  return { id: `label-${name}`, name, parentId: null };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: "## Context\nWhy.\n\n## Acceptance Criteria\n- [ ] Does the thing\n",
    priority: PRIORITY.Medium,
    estimate: 2,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_TODO,
    labels: [label(TYPE_LABEL.feature), label(FOREMAN_LABEL.blocked)],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "project-1", name: "Foreman" },
    parent: null,
    children: [],
    assignee: { id: "operator-1", name: "Operator", displayName: "Operator" },
    relations: [],
    comments: [],
    ...overrides,
  };
}

class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];

  constructor(issues: Issue[]) {
    for (const issue of issues) this.issuesById.set(issue.identifier, issue);
  }

  async issue(id: string): Promise<Issue | null> {
    return this.issuesById.get(id) ?? null;
  }
  async issues(): Promise<Issue[]> {
    return [...this.issuesById.values()];
  }
  async comments() {
    return [];
  }
  async viewerId(): Promise<string> {
    return "bot-1";
  }
  async userByEmail(): Promise<never> {
    throw new Error("not implemented");
  }
  async project() {
    return null;
  }
  async projectStatus() {
    return null;
  }
  async projectInitiatives() {
    return [];
  }
  async projectInitiative() {
    return { id: "initiative-1", name: "Foreman" };
  }
  async initiative() {
    return null;
  }
  async initiatives() {
    return [];
  }
  async initiativeProjects() {
    return [];
  }
  async workflowStates(): Promise<WorkflowState[]> {
    return [STATE_TODO];
  }
  async labels() {
    return [];
  }
  async teams() {
    return [{ id: "team-1", key: "ENG", name: "Engineering" }];
  }
  async projects() {
    return [];
  }
  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = [...this.issuesById.values()].find((candidate) => candidate.id === id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
    if (input.removedLabelIds) {
      issue.labels = issue.labels.filter((entry) => !input.removedLabelIds?.includes(entry.id));
    }
    if (input.assigneeId !== undefined) {
      issue.assignee = input.assigneeId ? { id: input.assigneeId, name: input.assigneeId, displayName: input.assigneeId } : null;
    }
    return issue;
  }
  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new Error("not implemented");
  }
  async createProject(input: { name: string; teamIds: string[] }): Promise<ProjectRef> {
    return { id: `project-created-${input.name}`, name: input.name };
  }
  async addProjectToInitiative() {}
  async updateProjectStatus() {}
  async createComment(input: { issueId: string; body: string; parentId?: string }): Promise<Comment> {
    this.commentCalls.push(input);
    return { id: `comment-${this.commentCalls.length}`, body: input.body, createdAt: new Date().toISOString(), user: null, parentId: input.parentId ?? null };
  }
  async createRelation() {}
  async deleteRelation() {}
  async projectRelations() {
    return [];
  }
  async createProjectRelation() {}
  async deleteProjectRelation() {}
  async createLabel(input: { name: string }): Promise<IssueLabel> {
    return label(input.name);
  }
  async ensureLabel(name: string): Promise<IssueLabel> {
    return label(name);
  }
}

describe("runUnblock", () => {
  it("removes the blocked label, records the reply, and hands the issue back from the operator", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);

    const result = await runUnblock(linear, "ENG-1", "Go ahead with option A.");

    expect(result.ok).toBe(true);
    expect(issue.labels.some((entry) => entry.name === FOREMAN_LABEL.blocked)).toBe(false);
    expect(linear.commentCalls).toHaveLength(1);
    expect(linear.commentCalls[0]?.body).toContain("Go ahead with option A.");
    expect(linear.updateCalls.some((call) => call.id === issue.id && call.input.assigneeId === null)).toBe(true);
    expect(issue.assignee).toBeNull();
  });

  it("rejects an empty reply without touching Linear", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue]);

    const result = await runUnblock(linear, "ENG-1", "   ");

    expect(result.ok).toBe(false);
    expect(linear.updateCalls).toHaveLength(0);
    expect(linear.commentCalls).toHaveLength(0);
  });

  it("refuses an issue with no foreman:blocked label", async () => {
    const issue = makeIssue({ labels: [label(TYPE_LABEL.feature)] });
    const linear = new FakeLinear([issue]);

    const result = await runUnblock(linear, "ENG-1", "reply");

    expect(result.ok).toBe(false);
    expect(result.message).toContain(FOREMAN_LABEL.blocked);
    expect(linear.updateCalls).toHaveLength(0);
  });
});
