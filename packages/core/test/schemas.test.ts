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
      proposedPriority: 2,
      severityReasoning: "Breaks login for all users.",
      duplicateOf: null,
      proposedBlockedBy: [],
      destinationProject: "Maintenance",
      destination: "Backlog",
      reproConfidence: "confirmed",
      missingInfo: [],
      triageLabel: null,
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
  projectOrganization: "Consistent with repo conventions.",
  scopeCreep: [],
  testAdequacy: "Tests fail if the change is reverted.",
  verdict: "approve",
};

const validPlanResult = {
  projectId: "project-1",
  proposedIssues: [
    {
      title: "Wire the search index",
      type: "type:feature",
      description: "## Context\nBuild the index.",
      acceptanceCriteria: ["Search returns results for a known query"],
      proposedPriority: 3,
      proposedEstimate: 2,
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

describe("parseAgentOutput", () => {
  it("parses a valid triage result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: validTriageResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
  });

  it("parses a valid review result envelope to kind: result", () => {
    const parsed = parseAgentOutput("foreman-review", {
      blocked: false,
      result: validReviewResult,
      block: null,
    });
    expect(parsed.kind).toBe("result");
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

  it("rejects a triage item missing destinationProject", () => {
    const { destinationProject: _destinationProject, ...itemWithoutDestinationProject } =
      validTriageResult.items[0]!;
    const parsed = parseAgentOutput("foreman-triage", {
      blocked: false,
      result: { ...validTriageResult, items: [itemWithoutDestinationProject] },
      block: null,
    });
    expect(parsed.kind).toBe("invalid");
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
    it(`${agent} schema round-trips through JSON.stringify/JSON.parse`, () => {
      const schema = AGENT_OUTPUT_SCHEMAS[agent];
      const roundTripped = JSON.parse(JSON.stringify(schema));
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(schema)));
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
