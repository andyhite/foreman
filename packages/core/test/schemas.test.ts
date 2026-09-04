import { describe, expect, it } from "bun:test";
import {
  AGENT_OUTPUT_SCHEMAS,
  type ForemanAgentName,
} from "../src/schemas/index.ts";
import { isBudgetTruncation, parseAgentOutput } from "../src/schemas/parse.ts";

const validTriageResult = {
  items: [
    {
      issueId: "ENG-1",
      type: "type:bug",
      app: null,
      proposedPriority: 2,
      severityReasoning: "Breaks login for all users.",
      duplicateOf: null,
      proposedBlockedBy: [],
      destination: "backlog",
      destinationProjectId: "project-1",
      newProject: null,
      missingInfo: [],
      draftDescription: null,
      proposedEstimate: null,
    },
  ],
  summary: "One bug moved to Backlog.",
};

const validReviewResult = {
  issueId: "ENG-2",
  reviewedSha: "abc123",
  criteriaVerification: [
    { criterion: "Login works", satisfied: true, evidence: "auth.ts:42" },
  ],
  dodSatisfied: true,
  dodChecklist: [{ item: "tests pass", satisfied: true, evidence: "ci green" }],
  findings: [],
  contextContradictions: [],
  projectOrganization: "Consistent with repo conventions.",
  scopeCreep: [],
  testAdequacy: "Tests fail if the change is reverted.",
  verdict: "approve",
};

const validImplementResult = {
  issueId: "ENG-2",
  branch: "eng-2-login",
  prUrl: "https://github.com/acme/repo/pull/1",
  headSha: "abc123",
  criteriaMet: [{ criterion: "Login works", evidence: "auth.ts:42" }],
  testsAdded: [{ path: "test/auth.test.ts", covers: "Login works" }],
  discoveredWork: [],
  contextContradictions: [],
  approachSummary: "Added a session cookie check to the login handler.",
};

const validPlanResult = {
  projectId: "project-1",
  proposedIssues: [
    {
      key: "search-index",
      title: "Wire the search index",
      type: "type:feature",
      app: null,
      description: "## Context\nBuild the index.",
      acceptanceCriteria: ["Search returns results for a known query"],
      proposedPriority: 3,
      proposedEstimate: 2,
      blockedBy: [],
    },
  ],
  outOfScope: ["Ranking tuning"],
  fullyPlanned: false,
  rationale: "One slice covers the brief's first milestone.",
};

const validBlock = {
  blocked: true,
  type: "needs-decision",
  whatIWasDoing: "Refining ENG-1.",
  whatINeed: "Which API to use.",
  options: null,
  recommendation: null,
  stateLeftBehind: {
    worktree: null,
    branch: null,
    pushed: false,
    commits: [],
    notes: "",
  },
  costOfWrongGuess: "Would need to redo the refinement.",
  blockedByIssues: [],
};

const dependencyBlock = {
  ...validBlock,
  type: "dependency",
  blockedByIssues: ["ENG-9"],
};

const validRefineResult = {
  issueId: "ENG-1",
  refinedDescription: "Search is slow because the index is unbounded.",
  estimate: 2,
  acceptanceCriteria: ["Search returns results for a known query in under 200ms"],
  affectedAreas: ["src/search/index.ts"],
  outOfScope: ["Ranking tuning"],
  subIssues: [],
  spikeCreated: null,
  readyForImplementation: true,
};

const validContextResult = {
  teamId: "team-1",
  decisions: "- We use TypeBox for all agent output schemas.",
  vocabulary: "- \"issue\": a Linear issue, never a GitHub issue.",
  nonGoals: "- We do not support non-Linear trackers.",
  removals: [],
  changeSummary: "Adds a note about GitHub vs Linear issue terminology.",
  rationale: "Contributors keep confusing the two in review comments.",
};

describe("parseAgentOutput", () => {
  it("parses a valid triage result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: validTriageResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("parses a valid refine result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-refine", {
      blocked: false,
      result: validRefineResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("rejects readyForImplementation: true with estimate > 3", () => {
    const parsed = parseAgentOutput("foreman-refine", {
      blocked: false,
      result: { ...validRefineResult, estimate: 5, subIssues: [], readyForImplementation: true },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/readyForImplementation"))).toBe(true);
    }
  });

  it("rejects estimate: 5 with an empty subIssues", () => {
    const parsed = parseAgentOutput("foreman-refine", {
      blocked: false,
      result: { ...validRefineResult, estimate: 5, subIssues: [], readyForImplementation: false },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/subIssues"))).toBe(true);
    }
  });

  it("rejects readyForImplementation: true with an empty acceptanceCriteria", () => {
    const parsed = parseAgentOutput("foreman-refine", {
      blocked: false,
      result: { ...validRefineResult, acceptanceCriteria: [], readyForImplementation: true },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/acceptanceCriteria"))).toBe(true);
    }
  });

  it("rejects verdict: approve with a blocking finding", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: {
        ...validReviewResult,
        verdict: "approve",
        findings: [{ severity: "blocking", file: "src/thing.ts", line: 1, description: "bug" }],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/verdict"))).toBe(true);
    }
  });

  it("rejects dodSatisfied: true with an unsatisfied checklist entry", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: {
        ...validReviewResult,
        dodSatisfied: true,
        dodChecklist: [{ item: "tests pass", satisfied: false, evidence: "ci red" }],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/dodSatisfied"))).toBe(true);
    }
  });

  it("rejects an unsatisfied criterion with no blocking finding", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: {
        ...validReviewResult,
        criteriaVerification: [
          { criterion: "Login works", satisfied: false, evidence: "auth.ts:42" },
        ],
        findings: [],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/findings"))).toBe(true);
    }
  });


  it("parses a valid review result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: validReviewResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("parses a review result with a populated contextContradictions", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: {
        ...validReviewResult,
        contextContradictions: [
          { section: "decisions", recorded: "Auth uses cookies, not JWT.", evidence: "auth.ts:12" },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("rejects a review result contextContradiction with an unknown section", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: {
        ...validReviewResult,
        contextContradictions: [
          { section: "bogus", recorded: "Auth uses cookies, not JWT.", evidence: "auth.ts:12" },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/contextContradictions"))).toBe(true);
    }
  });

  it("parses a valid implement result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-implement", {
      blocked: false,
      result: validImplementResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("parses an implement result with a populated contextContradictions", () => {
    const parsed = parseAgentOutput("foreman-implement", {
      blocked: false,
      result: {
        ...validImplementResult,
        contextContradictions: [
          { section: "non-goals", recorded: "No admin dashboard.", evidence: "src/admin.ts:1" },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("rejects an implement result contextContradiction with an unknown section", () => {
    const parsed = parseAgentOutput("foreman-implement", {
      blocked: false,
      result: {
        ...validImplementResult,
        contextContradictions: [
          { section: "bogus", recorded: "No admin dashboard.", evidence: "src/admin.ts:1" },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/contextContradictions"))).toBe(true);
    }
  });

  it("parses a valid context result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-context", {
      blocked: false,
      result: validContextResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("rejects a context result carrying a definitionOfDone property", () => {
    const parsed = parseAgentOutput("foreman-context", {
      blocked: false,
      result: { ...validContextResult, definitionOfDone: "Ship it." },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("parses a valid block envelope for context to kind: blocked", () => {
    const parsed = parseAgentOutput("foreman-context", {
      blocked: true,
      result: null,
      block: validBlock,
    });
    expect(parsed.kind).toBe("blocked");
  });

  it("parses a valid plan result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: validPlanResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("parses a valid block envelope for plan to kind: blocked", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: true,
      result: null,
      block: validBlock,
    });
    expect(parsed.kind).toBe("blocked");
  });

  it("rejects a plan proposedIssue with an out-of-scale estimate", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [{ ...validPlanResult.proposedIssues[0], proposedEstimate: 4 }],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("parses a valid plan dependency DAG to kind: result", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [
          { ...validPlanResult.proposedIssues[0], key: "schema", blockedBy: [] },
          { ...validPlanResult.proposedIssues[0], key: "api", blockedBy: ["schema"] },
          { ...validPlanResult.proposedIssues[0], key: "ui", blockedBy: ["schema", "api"] },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("rejects a plan result with duplicate proposal keys", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [
          { ...validPlanResult.proposedIssues[0], key: "dup", blockedBy: [] },
          { ...validPlanResult.proposedIssues[0], key: "dup", blockedBy: [] },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/proposedIssues"))).toBe(true);
    }
  });

  it("rejects a plan result whose blockedBy names no sibling key", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [{ ...validPlanResult.proposedIssues[0], key: "schema", blockedBy: ["ghost"] }],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/proposedIssues"))).toBe(true);
    }
  });

  it("rejects a plan result whose proposal blocks itself", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [{ ...validPlanResult.proposedIssues[0], key: "schema", blockedBy: ["schema"] }],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/proposedIssues"))).toBe(true);
    }
  });

  it("rejects a plan result with a two-node dependency cycle", () => {
    const parsed = parseAgentOutput("foreman-plan", {
      blocked: false,
      result: {
        ...validPlanResult,
        proposedIssues: [
          { ...validPlanResult.proposedIssues[0], key: "a", blockedBy: ["b"] },
          { ...validPlanResult.proposedIssues[0], key: "b", blockedBy: ["a"] },
        ],
      },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/proposedIssues"))).toBe(true);
    }
  });

  it("parses a valid block envelope to kind: blocked", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: true,
      result: null,
      block: validBlock,
    });
    expect(parsed.kind).toBe("blocked");
  });

  it("parses a valid block envelope for review to kind: blocked", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: true,
      result: null,
      block: validBlock,
    });
    expect(parsed.kind).toBe("blocked");
  });

  it("rejects blocked: false with a null result", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: null,
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("rejects blocked: true with a populated result", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: true,
      result: validTriageResult,
      block: validBlock,
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("rejects an unknown extra property", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: validTriageResult,
      block: null,
      extra: "nope",
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("rejects a dependency block with an empty blockedByIssues", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: true,
      result: null,
      block: { ...validBlock, type: "dependency", blockedByIssues: [] },
    });
    expect(parsed.kind).toBe("invalid");
  });

  it("accepts a dependency block with a non-empty blockedByIssues", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: true,
      result: null,
      block: dependencyBlock,
    });
    expect(parsed.kind).toBe("blocked");
  });

  it("reports a JSON pointer for a missing required field", () => {
    const { summary: _summary, ...withoutSummary } = validTriageResult;
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: withoutSummary,
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.problems.some((problem) => problem.includes("/result/summary"))).toBe(true);
    }
  });

  it("allows a project-less backlog triage item (work with no ship moment)", () => {
    const itemWithoutProjectId = { ...validTriageResult.items[0]!, destinationProjectId: null };
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: { ...validTriageResult, items: [itemWithoutProjectId] },
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });
});

describe("isBudgetTruncation", () => {
  it("is true only when aborted and there are problems", () => {
    expect(isBudgetTruncation({ aborted: true, problems: ["/result: required"] })).toBe(true);
    expect(isBudgetTruncation({ aborted: false, problems: ["/result: required"] })).toBe(false);
    expect(isBudgetTruncation({ aborted: true, problems: [] })).toBe(false);
  });
});

describe("AGENT_OUTPUT_SCHEMAS", () => {
  const agentNames = Object.keys(AGENT_OUTPUT_SCHEMAS) as ForemanAgentName[];

  for (const agent of agentNames) {
    it(`${agent} schema round-trips through JSON.stringify/JSON.parse with its envelope shape intact`, () => {
      const schema = AGENT_OUTPUT_SCHEMAS[agent];
      const roundTripped = JSON.parse(JSON.stringify(schema)) as {
        properties: { blocked: unknown; result: unknown; block: unknown };
        additionalProperties: boolean;
      };
      expect(roundTripped.properties.blocked).toBeDefined();
      expect(roundTripped.properties.result).toBeDefined();
      expect(roundTripped.properties.block).toBeDefined();
      expect(roundTripped.additionalProperties).toBe(false);
    });

    it(`${agent} schema has no external $ref`, () => {
      const schema = AGENT_OUTPUT_SCHEMAS[agent];
      const serialized = JSON.stringify(schema);
      const refs = [...serialized.matchAll(/"\$ref":"([^"]*)"/g)].map((match) => match[1]);
      for (const ref of refs) {
        expect(ref?.startsWith("#")).toBe(true);
      }
    });
  }
});
