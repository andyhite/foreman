import { describe, expect, it } from "bun:test";
import { implementationGate, refinementGate, reviewGate } from "../src/gates/index.ts";
import type { ReviewGateInput } from "../src/gates/review.ts";
import { AGENT_LABEL, BLOCKED_LABEL, LEGACY_LABEL, TYPE_LABEL } from "../src/domain/labels.ts";
import { PRIORITY } from "../src/domain/priority.ts";
import type { Issue, IssueLabel, IssueRelation, WorkflowState } from "../src/linear/types.ts";
import type { ReviewResult } from "../src/schemas/review.ts";

const STATE_TODO: WorkflowState = { id: "state-todo", name: "Todo", type: "unstarted", position: 2 };
const STATE_STARTED: WorkflowState = {
  id: "state-started",
  name: "In Progress",
  type: "started",
  position: 3,
};
const STATE_COMPLETED: WorkflowState = {
  id: "state-completed",
  name: "Done",
  type: "completed",
  position: 5,
};

const ACCEPTANCE_CRITERIA = "## Acceptance Criteria\n- [ ] Does the thing\n";

function label(name: string): IssueLabel {
  return { id: `label-${name}`, name, parentId: null };
}

/** Builds a fully-refined, dispatch-ready issue; tests override fields per case. */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Do the thing",
    description: `## Context\nWhy.\n\n${ACCEPTANCE_CRITERIA}`,
    priority: PRIORITY.Medium,
    estimate: 2,
    url: "https://linear.app/foreman/issue/ENG-1",
    branchName: "eng-1-do-the-thing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: STATE_TODO,
    labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready)],
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    project: null,
    parent: null,
    children: [],
    assignee: null,
    relations: [],
    comments: [],
    ...overrides,
  };
}

function blockingRelation(stateType: WorkflowState["type"]): IssueRelation {
  return {
    id: "rel-1",
    type: "blocks",
    direction: "incoming",
    other: {
      id: "issue-blocker",
      identifier: "ENG-0",
      title: "Blocker",
      state: { id: "s", name: stateType, type: stateType },
    },
  };
}

describe("refinementGate", () => {
  it("passes a fully refined issue", () => {
    const result = refinementGate(makeIssue());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails missing-type-label", () => {
    const result = refinementGate(makeIssue({ labels: [] }));
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("missing-type-label");
  });

  it("fails priority-none", () => {
    const result = refinementGate(makeIssue({ priority: PRIORITY.None }));
    expect(result.failures.map((f) => f.code)).toContain("priority-none");
  });

  it("fails missing-acceptance-criteria when the section is absent", () => {
    const result = refinementGate(makeIssue({ description: "## Context\nNo criteria here." }));
    expect(result.failures.map((f) => f.code)).toContain("missing-acceptance-criteria");
  });

  it("fails missing-estimate when estimate is null", () => {
    const result = refinementGate(makeIssue({ estimate: null }));
    expect(result.failures.map((f) => f.code)).toContain("missing-estimate");
  });

  it("passes at exactly the estimate cap of 3", () => {
    const result = refinementGate(makeIssue({ estimate: 3 }));
    expect(result.ok).toBe(true);
  });

  it("fails estimate-too-large above the cap", () => {
    const result = refinementGate(makeIssue({ estimate: 5 }));
    expect(result.failures.map((f) => f.code)).toContain("estimate-too-large");
  });

  it("fails blocked-label-present", () => {
    const result = refinementGate(
      makeIssue({ labels: [label(TYPE_LABEL.feature), label(BLOCKED_LABEL.needsInput)] }),
    );
    expect(result.failures.map((f) => f.code)).toContain("blocked-label-present");
  });
});

describe("implementationGate", () => {
  it("passes a dispatch-ready issue", () => {
    const result = implementationGate(makeIssue());
    expect(result.ok).toBe(true);
  });

  it("folds refinement failures in", () => {
    const result = implementationGate(makeIssue({ estimate: null }));
    expect(result.failures.map((f) => f.code)).toContain("missing-estimate");
  });

  it("fails missing-agent-ready", () => {
    const result = implementationGate(makeIssue({ labels: [label(TYPE_LABEL.feature)] }));
    expect(result.failures.map((f) => f.code)).toContain("missing-agent-ready");
  });

  it("fails agent-running", () => {
    const result = implementationGate(
      makeIssue({
        labels: [label(TYPE_LABEL.feature), label(AGENT_LABEL.ready), label(AGENT_LABEL.running)],
      }),
    );
    expect(result.failures.map((f) => f.code)).toContain("agent-running");
  });

  it("fails agent-hands-off", () => {
    const result = implementationGate(
      makeIssue({
        labels: [
          label(TYPE_LABEL.feature),
          label(AGENT_LABEL.ready),
          label(AGENT_LABEL.handsOff),
        ],
      }),
    );
    expect(result.failures.map((f) => f.code)).toContain("agent-hands-off");
  });

  it("fails incomplete-blockers for a blocker still in progress", () => {
    const result = implementationGate(makeIssue({ relations: [blockingRelation("started")] }));
    expect(result.failures.map((f) => f.code)).toContain("incomplete-blockers");
  });

  it("passes when the blocker is completed", () => {
    const result = implementationGate(makeIssue({ relations: [blockingRelation("completed")] }));
    expect(result.ok).toBe(true);
  });

  it("never bypasses the gate for a legacy issue sitting in Todo (SPEC §4.9)", () => {
    const legacyIssue = makeIssue({
      description: null,
      priority: PRIORITY.None,
      estimate: null,
      labels: [label(LEGACY_LABEL)],
      state: STATE_TODO,
    });
    const result = implementationGate(legacyIssue);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("missing-agent-ready");
    expect(result.failures.map((f) => f.code)).toContain("missing-type-label");
  });
});

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    issueId: "issue-1",
    reviewedSha: "sha-abc",
    criteriaVerification: [
      { criterion: "Does the thing", satisfied: true, evidence: "src/thing.ts:10" },
    ],
    dodSatisfied: true,
    dodChecklist: [{ item: "Tests pass", satisfied: true, evidence: "ci" }],
    findings: [],
    projectOrganization: "no concerns",
    scopeCreep: [],
    testAdequacy: "yes",
    verdict: "approve",
    ...overrides,
  };
}

function makeReviewInput(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    issue: makeIssue(),
    review: makeReview(),
    headSha: "sha-abc",
    ciStatus: "success",
    prOpen: true,
    prRequired: true,
    ciRequired: true,
    ...overrides,
  };
}

describe("reviewGate", () => {
  it("passes a clean PR-mode review", () => {
    const result = reviewGate(makeReviewInput());
    expect(result.ok).toBe(true);
  });

  it("fails missing-review when no ReviewResult exists", () => {
    const result = reviewGate(makeReviewInput({ review: null }));
    expect(result.failures.map((f) => f.code)).toContain("missing-review");
  });

  it("fails stale-review when reviewedSha does not match head", () => {
    const result = reviewGate(makeReviewInput({ headSha: "sha-new" }));
    expect(result.failures.map((f) => f.code)).toContain("stale-review");
  });

  it("fails ci-not-green when CI is required and not success", () => {
    const result = reviewGate(makeReviewInput({ ciStatus: "pending" }));
    expect(result.failures.map((f) => f.code)).toContain("ci-not-green");
  });

  it("fails blocking-findings when a blocking finding is outstanding", () => {
    const result = reviewGate(
      makeReviewInput({
        review: makeReview({
          findings: [{ severity: "blocking", file: "src/thing.ts", line: 5, description: "bug" }],
        }),
      }),
    );
    expect(result.failures.map((f) => f.code)).toContain("blocking-findings");
  });

  it("fails unverified-criteria when a criterion is unchecked", () => {
    const result = reviewGate(
      makeReviewInput({
        review: makeReview({
          criteriaVerification: [
            { criterion: "Does the thing", satisfied: false, evidence: "src/thing.ts:10" },
          ],
        }),
      }),
    );
    expect(result.failures.map((f) => f.code)).toContain("unverified-criteria");
  });

  it("fails dod-unsatisfied when the Definition of Done is not met", () => {
    const result = reviewGate(makeReviewInput({ review: makeReview({ dodSatisfied: false }) }));
    expect(result.failures.map((f) => f.code)).toContain("dod-unsatisfied");
  });

  it("PR mode: fails pr-not-open when prRequired and the PR is closed", () => {
    const result = reviewGate(makeReviewInput({ prOpen: false }));
    expect(result.failures.map((f) => f.code)).toContain("pr-not-open");
  });

  it("direct-branch mode (prRequired: false): does not check PR state", () => {
    const result = reviewGate(makeReviewInput({ prRequired: false, prOpen: false }));
    expect(result.ok).toBe(true);
  });
});
