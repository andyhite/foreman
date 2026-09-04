import { describe, expect, it } from "bun:test";
import { acceptanceCriteria, openQuestions } from "@foreman/core";
import {
  renderBlockComment,
  renderImplementComment,
  renderIssueDescription,
  renderReviewComment,
  renderSpikeIssue,
  renderStatusConsole,
} from "../src/render/index.ts";
import type { BlockRecord, ContextContradiction, ImplementResult, SpikeSpec, ReviewResult } from "@foreman/core";
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

  // An agent whose `description`/`refinedDescription` carries the whole §13.1
  // template — the shape every schema description used to ask for — must not
  // produce one template nested inside another's Context section. The
  // structured fields stay authoritative; only the context prose is taken.
  it("unwraps a context that arrives as a full §13.1 template", () => {
    const output = renderIssueDescription({
      context: [
        "## Context",
        "The dedupe pass matches titles exactly, so near-duplicates both land in Backlog.",
        "",
        "## Acceptance Criteria",
        "- [ ] A stale criterion the agent drafted before reading the code",
        "",
        "## Affected Areas",
        "- guessed/path.ts",
        "",
        "## Out of Scope",
        "- Something else",
        "",
        "## Open Questions",
        "- Is this even right?",
      ].join("\n"),
      acceptanceCriteria: ["Near-duplicates are proposed as duplicateOf"],
      affectedAreas: ["packages/core/src/linear/issue.ts"],
      outOfScope: ["Embedding-based similarity"],
    });

    for (const heading of ["## Context", "## Acceptance Criteria", "## Affected Areas", "## Out of Scope", "## Open Questions"]) {
      expect(output.split("\n").filter((line) => line === heading)).toHaveLength(1);
    }
    expect(output).toContain("The dedupe pass matches titles exactly");
    expect(acceptanceCriteria(output)).toEqual(["Near-duplicates are proposed as duplicateOf"]);
    expect(output).not.toContain("A stale criterion");
    expect(openQuestions(output)).toEqual([]);
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
    contextContradictions: [],
    findings: [
      { severity: "nit", severityRationale: "Cosmetic only.", file: "src/a.ts", line: 10, description: "Rename variable." },
      { severity: "blocking", severityRationale: "Null deref crashes on save.", file: "src/b.ts", line: 5, description: "Missing null check." },
      { severity: "should-fix", severityRationale: "Duplicated logic, not incorrect.", file: "src/c.ts", line: null, description: "Consider extracting helper." },
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

  it("carries each finding's severity rationale on a continuation line", () => {
    const output = renderReviewComment(baseResult);
    expect(output).toContain("_blocking: Null deref crashes on save._");
  });

  it("states an empty severity group explicitly rather than omitting it", () => {
    const noBlocking: ReviewResult = {
      ...baseResult,
      findings: [{ severity: "nit", severityRationale: "Cosmetic only.", file: "src/a.ts", line: 1, description: "x" }],
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


  it("renders a Context Doc Contradictions section with section, quoted claim, and evidence when present", () => {
    const contradictions: ContextContradiction[] = [
      {
        section: "decisions",
        recorded: "We only support Postgres.",
        evidence: "src/db/mysql-adapter.ts:12",
      },
    ];
    const output = renderReviewComment({ ...baseResult, contextContradictions: contradictions });
    expect(output).toContain("## Context Doc Contradictions");
    expect(output).toContain("decisions");
    expect(output).toContain('"We only support Postgres."');
    expect(output).toContain("src/db/mysql-adapter.ts:12");
  });

  it("omits the Context Doc Contradictions heading entirely when there are none", () => {
    const output = renderReviewComment(baseResult);
    expect(output).not.toContain("## Context Doc Contradictions");
  });
});

describe("renderImplementComment", () => {
  const baseResult: ImplementResult = {
    issueId: "ENG-1",
    branch: "eng-1-fix-auth",
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "cafef00d",
    criteriaMet: [{ criterion: "Logs out", evidence: "auth.test.ts:12" }],
    testsAdded: [{ path: "auth.test.ts", covers: "Logs out" }],
    discoveredWork: [],
    contextContradictions: [],
    approachSummary: "Cleared the session cookie on logout.",
  };

  it("names the branch, PR, and approach", () => {
    const output = renderImplementComment(baseResult);
    expect(output).toContain("**Branch:** eng-1-fix-auth");
    expect(output).toContain("**PR:** https://github.com/acme/repo/pull/42");
    expect(output).toContain("**Approach:** Cleared the session cookie on logout.");
  });

  it("states no PR in direct-branch mode", () => {
    const output = renderImplementComment({ ...baseResult, prUrl: "" });
    expect(output).toContain("**PR:** none (direct-branch mode)");
  });

  it("renders a Context Doc Contradictions section with section, quoted claim, and evidence when present", () => {
    const contradictions: ContextContradiction[] = [
      {
        section: "vocabulary",
        recorded: "A \"lock\" is per-issue.",
        evidence: "src/lock.ts:30",
      },
    ];
    const output = renderImplementComment({ ...baseResult, contextContradictions: contradictions });
    expect(output).toContain("## Context Doc Contradictions");
    expect(output).toContain("vocabulary");
    expect(output).toContain('"A "lock" is per-issue."');
    expect(output).toContain("src/lock.ts:30");
  });

  it("omits the Context Doc Contradictions heading entirely when there are none", () => {
    const output = renderImplementComment(baseResult);
    expect(output).not.toContain("## Context Doc Contradictions");
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
    expect(output.toLowerCase()).toContain("no `foreman:blocked` label was applied");
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
    needsInput: [],
    blocked: [{ issueId: "ENG-7", excerpt: "Which cache backend?" }],
    running: [
      { issueId: "ENG-9", agent: "foreman-implement", dispatchId: "d-1", ageMs: 3 * 60 * 60 * 1000, pastTtl: true },
    ],
    backlogCount: 0,
    readyCount: 0,
    loops: [],
  };

  it("leads with a bold summary line before every section", () => {
    const output = renderStatusConsole(state);
    expect(
      output.startsWith(
        "**1 waiting on the operator (0 needs input, 1 blocked) · 1 running (1 past TTL) · 0 ready · 0 backlog**",
      ),
    ).toBe(true);
  });

  it("includes ready and backlog counts in the headline", () => {
    const output = renderStatusConsole({ ...state, backlogCount: 11, readyCount: 4 });
    expect(output).toContain("4 ready");
    expect(output).toContain("11 backlog");
  });

  it("puts the needs-input queue first among the ## sections", () => {
    const output = renderStatusConsole(state);
    const needsInputIndex = output.indexOf("## Needs Input");
    expect(needsInputIndex).toBeGreaterThan(0);
    expect(output.indexOf("##")).toBe(needsInputIndex);
    const nextSectionIndex = output.indexOf("##", needsInputIndex + 1);
    expect(nextSectionIndex).toBeGreaterThan(needsInputIndex);
  });

  it("collapses empty sections to one line and names the next action on a fully empty board", () => {
    const empty: StatusState = {
      needsInput: [],
      blocked: [],
      running: [],
      backlogCount: 0,
      readyCount: 0,
      loops: [],
    };
    const output = renderStatusConsole(empty);
    expect(output.split("\n").filter((line) => line.includes("_none")).length).toBeGreaterThan(0);
    expect(output).toContain("Nothing queued.");
    expect(output).toContain("build: not running");
    expect(output).toContain("plan: not running");
  });

  it("shows a running loop's pid and uptime in the Loops section", () => {
    const output = renderStatusConsole({
      ...state,
      loops: [{ name: "build", pid: 74665, startedAt: new Date(Date.now() - 60_000).toISOString() }],
    });
    const loopsSection = output.slice(output.indexOf("## Loops"));
    expect(loopsSection).toContain("build: running (pid 74665");
    expect(loopsSection).toContain("plan: not running");
  });
});

describe("openQuestions", () => {
  it("round-trips a freshly rendered description with no open questions as empty", () => {
    const description = renderIssueDescription({
      context: "Context",
      acceptanceCriteria: [],
      affectedAreas: [],
      outOfScope: [],
    });

    expect(openQuestions(description)).toEqual([]);
  });
});
