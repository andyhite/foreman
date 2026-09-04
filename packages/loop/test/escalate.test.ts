import { describe, expect, it } from "bun:test";
import type { Issue, WorkflowState } from "@foreman/core";
import { FakeLinear } from "./fake-linear.ts";
import { applyEscalation } from "../src/escalate.ts";

const STATE_READY: WorkflowState = { id: "state-ready", name: "Ready", type: "unstarted", position: 3 };
const STATE_BLOCKED: WorkflowState = { id: "state-blocked", name: "Blocked", type: "started", position: 4 };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: null,
    priority: 3,
    estimate: null,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_READY,
    labels: [],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: { id: "project-1", name: "Foreman" },
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

describe("applyEscalation", () => {
  it("moves the issue to Blocked and posts a block marker", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], [STATE_READY, STATE_BLOCKED]);

    const line = await applyEscalation(linear, {
      issueId: issue.id,
      kind: "retry-exhausted",
      attempts: 3,
      detail: "boom",
    });

    expect(line).toContain("escalated to Blocked");
    expect(linear.commentCalls).toHaveLength(1);
    expect(linear.updateCalls).toHaveLength(1);
    expect(linear.updateCalls[0]?.input).toMatchObject({ stateId: "state-blocked", assigneeId: null });
  });

  it("leaves the state move uncalled when createComment fails", async () => {
    const issue = makeIssue();
    const linear = new FakeLinear([issue], [STATE_READY, STATE_BLOCKED]);
    linear.createComment = async () => {
      throw new Error("network down");
    };

    await expect(
      applyEscalation(linear, {
        issueId: issue.id,
        kind: "retry-exhausted",
        attempts: 3,
        detail: "boom",
      }),
    ).rejects.toThrow("network down");

    expect(linear.updateCalls).toHaveLength(0);
  });
});
