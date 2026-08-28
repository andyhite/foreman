import { describe, expect, it } from "bun:test";
import { acceptanceCriteria } from "../src/linear/issue.ts";
import {
  renderBlockComment,
  renderIssueDescription,
  renderPrBody,
  renderProposalComment,
  renderReviewComment,
  renderSpikeIssue,
  renderStatusConsole,
} from "../src/render/index.ts";
import type { BlockRecord } from "../src/schemas/envelope.ts";
import type { ImplementResult } from "../src/schemas/implement.ts";
import type { SpikeSpec } from "../src/schemas/refine.ts";
import type { ReviewResult } from "../src/schemas/review.ts";
import type { TriageItem } from "../src/schemas/triage.ts";
import type { StatusState } from "../src/render/status.ts";

describe("renderIssueDescription", () => {
  it("emits the exact SPEC §13.1 section headings in order", () => {
    const output = renderIssueDescription({
      context: "Why this exists.",
      acceptanceCriteria: ["Thing A happens", "Thing B happens"],
      affectedAreas: ["packages/core/src/render"],
      outOfScope: ["Not touching the loop"],
      openQuestions: [],
    });
    const headings = ["## Context", "## Acceptance Criteria", "## Affected Areas", "## Out of Scope", "## Open Questions"];
    let cursor = -1;
    for (const heading of headings) {
      const index = output.indexOf(heading);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("round-trips acceptance criteria through acceptanceCriteria()", () => {
    const criteria = ["A logged-in user can log out", "Session token is invalidated"];
    const output = renderIssueDescription({
      context: "ctx",
      acceptanceCriteria: criteria,
      affectedAreas: [],
      outOfScope: [],
    });
    expect(acceptanceCriteria(output)).toEqual(criteria);
  });

  it("renders _none_ for empty sections", () => {
    const output = renderIssueDescription({
      context: "",
      acceptanceCriteria: [],
      affectedAreas: [],
      outOfScope: [],
      openQuestions: [],
    });
    expect(output).toContain("_none_");
    // Every section except acceptance criteria (which uses the same marker) should say _none_.
    const noneCount = output.split("_none_").length - 1;
    expect(noneCount).toBe(5);
  });

  it("never restates the Definition of Done", () => {
    const output = renderIssueDescription({
      context: "ctx",
      acceptanceCriteria: ["x"],
      affectedAreas: [],
      outOfScope: [],
    });
    expect(output.toLowerCase()).not.toContain("definition of done");
  });
});

describe("renderPrBody", () => {
  const implementResult: ImplementResult = {
    issueId: "ENG-142",
    branch: "eng-142-fix-thing",
    prUrl: "https://github.com/example/repo/pull/1",
    headSha: "abc123",
    criteriaMet: [{ criterion: "Thing works", evidence: "test.ts:12" }],
    testsAdded: [{ path: "test/thing.test.ts", covers: "Thing works" }],
    discoveredWork: [
      { title: "Fix flaky test", description: "Found while implementing.", type: "type:bug", relation: "related" },
      { title: "Refactor helper", description: "Extract shared logic.", type: "type:chore", relation: "blocks" },
    ],
    approachSummary: "Added a guard clause and a test.",
  };

  it("includes every discovered-work item and every DoD line", () => {
    const output = renderPrBody({
      issue: { identifier: "ENG-142", url: "https://linear.app/x/issue/ENG-142", title: "Fix the thing" },
      result: implementResult,
      definitionOfDone: ["Tests pass", "No lint errors", "Docs updated"],
    });
    expect(output).toContain("Fix flaky test");
    expect(output).toContain("Refactor helper");
    expect(output).toContain("- [ ] Tests pass");
    expect(output).toContain("- [ ] No lint errors");
    expect(output).toContain("- [ ] Docs updated");
    expect(output).toContain("ENG-142");
  });
});

describe("renderSpikeIssue", () => {
  it("names the question, budget, deliverable, and the blocked issue", () => {
    const spec: SpikeSpec = {
      title: "Investigate dedupe threshold",
      question: "What similarity score correlates with real duplicates?",
      budget: "one session",
      deliverable: "A written recommendation with sample data.",
    };
    const output = renderSpikeIssue(spec, { identifier: "ENG-99" });
    expect(output).toContain(spec.question);
    expect(output).toContain(spec.budget);
    expect(output).toContain("## Deliverable");
    expect(output).toContain(spec.deliverable);
    expect(output).toContain("ENG-99");
  });
});

describe("renderReviewComment", () => {
  const baseResult: ReviewResult = {
    issueId: "ENG-1",
    reviewedSha: "deadbeef",
    criteriaVerification: [{ criterion: "Logs out", satisfied: true, evidence: "auth.ts:40" }],
    dodSatisfied: true,
    dodChecklist: [{ item: "Tests pass", satisfied: true, evidence: "CI green" }],
    findings: [
      { severity: "nit", file: "src/a.ts", line: 10, description: "Rename variable." },
      { severity: "blocking", file: "src/b.ts", line: 5, description: "Missing null check." },
      { severity: "should-fix", file: "src/c.ts", line: null, description: "Consider extracting helper." },
    ],
    projectOrganization: "No concerns.",
    scopeCreep: [],
    testAdequacy: "Tests would fail if reverted.",
    verdict: "request-changes",
  };

  it("orders severity groups blocking, should-fix, nit", () => {
    const output = renderReviewComment(baseResult);
    const blockingIndex = output.indexOf("### blocking");
    const shouldFixIndex = output.indexOf("### should-fix");
    const nitIndex = output.indexOf("### nit");
    expect(blockingIndex).toBeGreaterThan(-1);
    expect(shouldFixIndex).toBeGreaterThan(blockingIndex);
    expect(nitIndex).toBeGreaterThan(shouldFixIndex);
    expect(output.indexOf("src/b.ts:5")).toBeGreaterThan(blockingIndex);
    expect(output.indexOf("src/a.ts:10")).toBeGreaterThan(nitIndex);
  });

  it("states an empty severity group explicitly rather than omitting it", () => {
    const noBlocking: ReviewResult = {
      ...baseResult,
      findings: [{ severity: "nit", file: "src/a.ts", line: 1, description: "x" }],
    };
    const output = renderReviewComment(noBlocking);
    const blockingSection = output.slice(
      output.indexOf("### blocking"),
      output.indexOf("### should-fix"),
    );
    expect(blockingSection).toContain("_none_");
  });

  it("includes the reviewed SHA and the standing project-organization section", () => {
    const output = renderReviewComment(baseResult);
    expect(output).toContain("deadbeef");
    expect(output).toContain("## Project Organization");
    expect(output).toContain("No concerns.");
  });
});

describe("renderProposalComment", () => {
  const item: TriageItem = {
    issueId: "ENG-7",
    type: "type:bug",
    proposedPriority: 2,
    severityReasoning: "Affects login for all users.",
    duplicateOf: null,
    proposedBlockedBy: ["ENG-3"],
    destination: "Backlog",
    reproConfidence: "confirmed",
    missingInfo: [],
    triageLabel: null,
    destinationProject: "Maintenance",
  };

  it("contains both the approve and reject instructions", () => {
    const output = renderProposalComment(item);
    expect(output).toContain("agent:proposed");
    expect(output).toContain("remove");
    expect(output).toContain("reject: <reason>");
  });

  it("includes priority, severity reasoning, and proposed blockers", () => {
    const output = renderProposalComment(item);
    expect(output).toContain("High");
    expect(output).toContain("Affects login for all users.");
    expect(output).toContain("ENG-3");
  });

  it("renders the type label once and names the proposed project", () => {
    /*
     * `type` already carries the `type:` prefix, so the renderer must not add a
     * second one — this pins the exact string an operator reads.
     */
    const output = renderProposalComment(item);
    expect(output).toContain("`type:bug`");
    expect(output).not.toContain("type:type:");
    expect(output).toContain("**Project:** Maintenance");
  });

  it("says why an unassigned project matters rather than printing nothing", () => {
    const output = renderProposalComment({ ...item, destinationProject: null });
    expect(output).toContain("refinement gate");
  });
});

describe("renderBlockComment", () => {
  it("names the blockers and states no label was applied for a dependency block", () => {
    const record: BlockRecord = {
      blocked: true,
      type: "dependency",
      whatIWasDoing: "Implementing the auth flow.",
      whatINeed: "ENG-3 to land first.",
      options: null,
      recommendation: null,
      stateLeftBehind: {
        worktree: "../repo-ENG-7",
        branch: "eng-7-auth",
        pushed: false,
        commits: [],
        notes: "",
      },
      costOfWrongGuess: "Would ship against an unstable interface.",
      blockedByIssues: ["ENG-3", "ENG-4"],
    };
    const output = renderBlockComment(record);
    expect(output).toContain("ENG-3, ENG-4");
    expect(output.toLowerCase()).toContain("no `blocked:*` label was applied");
  });

  it("renders options and recommendation for a needs-decision block", () => {
    const record: BlockRecord = {
      blocked: true,
      type: "needs-decision",
      whatIWasDoing: "Choosing a caching strategy.",
      whatINeed: "Which cache backend to use.",
      options: [
        { label: "Redis", tradeoff: "Extra infra." },
        { label: "In-memory", tradeoff: "Doesn't survive restarts." },
      ],
      recommendation: "Redis, since this needs to survive restarts.",
      stateLeftBehind: {
        worktree: "../repo-ENG-8",
        branch: "eng-8-cache",
        pushed: true,
        commits: ["abc123"],
        notes: "",
      },
      costOfWrongGuess: "Rework if the wrong backend is picked.",
      blockedByIssues: [],
    };
    const output = renderBlockComment(record);
    expect(output).toContain("Redis");
    expect(output).toContain("In-memory");
    expect(output).toContain("Redis, since this needs to survive restarts.");
  });
});

describe("renderStatusConsole", () => {
  const state: StatusState = {
    blocked: [{ issueId: "ENG-7", type: "needs-decision", question: "Which cache backend?" }],
    locks: [
      { issueId: "ENG-9", agent: "foreman-implement", dispatchId: "d-1", ageMs: 3 * 60 * 60 * 1000, pastTtl: true },
    ],
    proposalsAwaiting: { count: 2, issueIds: ["ENG-10", "ENG-11"] },
    agents: [{ agent: "foreman-implement", state: "running", issueId: "ENG-9" }],
    loop: {
      stage: "implement",
      workers: [{ worker: "implement", lastRunAt: "2026-08-28T00:00:00Z", dispatchCount: 3 }],
    },
    backpressure: { tripped: true, reason: "Blocked (human) queue exceeds threshold of 5" },
  };

  it("puts the blocked queue first", () => {
    const output = renderStatusConsole(state);
    const blockedIndex = output.indexOf("## Blocked");
    expect(blockedIndex).toBe(0);
    const nextSectionIndex = output.indexOf("##", blockedIndex + 1);
    expect(nextSectionIndex).toBeGreaterThan(blockedIndex);
  });

  it("shows a tripped backpressure reason", () => {
    const output = renderStatusConsole(state);
    expect(output).toContain("TRIPPED");
    expect(output).toContain("Blocked (human) queue exceeds threshold of 5");
  });

  it("collapses empty sections to one line", () => {
    const empty: StatusState = {
      blocked: [],
      locks: [],
      proposalsAwaiting: { count: 0, issueIds: [] },
      agents: [],
      loop: { stage: "idle", workers: [] },
      backpressure: { tripped: false, reason: null },
    };
    const output = renderStatusConsole(empty);
    expect(output).toContain("clear");
    expect(output.split("\n").filter((line) => line.includes("_none_")).length).toBeGreaterThan(0);
  });
});
