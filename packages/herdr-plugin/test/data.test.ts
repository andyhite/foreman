import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMarker, type BlockRecord, type GlobalConfig, type TriageItem } from "@foreman/core";
import { fetchBlockedEntries, fetchProposalEntries, readLoopBookkeeping } from "../src/data.ts";
import { LinearClient } from "@foreman/core";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const WIRE_STATE = { id: "state-1", name: "Todo", type: "unstarted" };

function wireIssue(id: string, comments: Array<{ id: string; body: string; createdAt: string }>) {
  return {
    id: `issue-${id}`,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: 1,
    estimate: 2,
    url: `https://linear.app/x/issue/ENG-${id}`,
    branchName: `eng-${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    state: WIRE_STATE,
    labels: { nodes: [] },
    project: null,
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    assignee: null,
    parent: null,
    children: { nodes: [] },
    relations: { nodes: [] },
    comments: {
      nodes: comments.map((c) => ({ ...c, user: null, parent: null })),
    },
  };
}

function clientReturning(issues: unknown[]): LinearClient {
  const fetchImpl = async () =>
    jsonResponse({ data: { issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } } } });
  return new LinearClient({ apiKey: "test-key", fetch: fetchImpl });
}

const VALID_BLOCK: BlockRecord = {
  blocked: true,
  type: "needs-decision",
  whatIWasDoing: "Implementing the auth flow",
  whatINeed: "Which token store to use",
  options: [{ label: "cookies", tradeoff: "simpler" }, { label: "JWT", tradeoff: "stateless" }],
  recommendation: "cookies",
  stateLeftBehind: { worktree: "/tmp/wt", branch: "eng-1-x", pushed: true, commits: ["abc"], notes: "" },
  costOfWrongGuess: "rework of the session layer",
  blockedByIssues: [],
};

describe("fetchBlockedEntries", () => {
  it("builds blocked entries from real foreman:block marker comments", async () => {
    const body = encodeMarker("block", VALID_BLOCK, "I'm stuck.");
    const client = clientReturning([
      wireIssue("1", [{ id: "c1", body, createdAt: "2026-01-02T00:00:00Z" }]),
    ]);
    const entries = await fetchBlockedEntries(client);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.issue.identifier).toBe("ENG-1");
    expect(entries[0]?.record.whatINeed).toBe("Which token store to use");
    expect(entries[0]?.commentId).toBe("c1");
  });

  it("skips a malformed marker rather than crashing the screen", async () => {
    const malformed = `Stuck.\n\n\`\`\`json\n${JSON.stringify({ foreman: "block", version: 1, data: { blocked: true } })}\n\`\`\``;
    const client = clientReturning([
      wireIssue("2", [{ id: "c2", body: malformed, createdAt: "2026-01-02T00:00:00Z" }]),
    ]);
    const entries = await fetchBlockedEntries(client);
    expect(entries).toHaveLength(0);
  });
});

const PROPOSAL_ITEM: TriageItem = {
  issueId: "ENG-3",
  type: "type:bug",
  proposedPriority: 2,
  severityReasoning: "Data loss on save",
  duplicateOf: null,
  proposedBlockedBy: [],
  destination: "Backlog",
  destinationProject: "Maintenance",
  reproConfidence: "confirmed",
  missingInfo: [],
  triageLabel: null,
};

describe("fetchProposalEntries", () => {
  it("reads proposal items from foreman:proposal markers", async () => {
    const body = encodeMarker("proposal", PROPOSAL_ITEM, "Proposed.");
    const client = clientReturning([
      wireIssue("3", [{ id: "c3", body, createdAt: "2026-01-02T00:00:00Z" }]),
    ]);
    const entries = await fetchProposalEntries(client);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.item.issueId).toBe("ENG-3");
  });

  it("excludes an already-applied item (a later foreman:applied marker)", async () => {
    const proposalBody = encodeMarker("proposal", PROPOSAL_ITEM, "Proposed.");
    const appliedBody = encodeMarker("applied", { at: "2026-01-03T00:00:00Z" }, "Applied.");
    const client = clientReturning([
      wireIssue("4", [
        { id: "c4", body: proposalBody, createdAt: "2026-01-02T00:00:00Z" },
        { id: "c5", body: appliedBody, createdAt: "2026-01-03T00:00:00Z" },
      ]),
    ]);
    const entries = await fetchProposalEntries(client);
    expect(entries).toHaveLength(0);
  });
});

function makeConfig(stateDir: string, repos: GlobalConfig["repos"] = {}): GlobalConfig {
  return {
    repos,
    loop: {
      wipGlobal: 3,
      wip: { refine: 2, implement: 3, review: 2 },
      readyBufferTarget: 5,
      backpressureThreshold: 5,
      retryCap: 2,
      reviewCycleCap: 2,
      cadenceMinutes: 5,
      stage: "dry-run",
      dispatcher: "print",
      mergeDetection: true,
      stateDir,
    },
    intake: { window: "06:00", staleLowDays: 90, batchSize: 20 },
    linear: { apiKeyEnv: "LINEAR_API_KEY", apiKeyFile: null, endpoint: "https://api.linear.app/graphql" },
    agent: { maxRuntimeMs: 7_200_000, lockTtlMarginMs: 1_800_000, ompBin: "omp", approvalMode: "yolo", herdrBin: "herdr" },
    repoDefaults: {
      baseBranch: "main",
      pr: { required: true, draft: false, ciRequired: true },
      merge: { strategy: "squash", deleteBranch: true },
      branchPattern: "<issue-id>-<slug>",
      worktreePattern: "../<repo>-<ISSUE-ID>",
    },
  };
}

describe("readLoopBookkeeping — intake bookkeeping reaches the board (defect fix)", () => {
  it("merges intake's own lastRunAt.intake even with no matching config.repos entry", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "foreman-board-data-"));
    const intakeDir = join(stateDir, "intake");
    mkdirSync(intakeDir, { recursive: true });
    writeFileSync(
      join(intakeDir, "bookkeeping.json"),
      JSON.stringify({ lastRunAt: { intake: "2026-08-28T12:00:00.000Z" } }),
    );

    const config = makeConfig(stateDir); // no `repos` entries at all
    const bookkeeping = readLoopBookkeeping(config);

    expect(bookkeeping.lastRunAt.intake).toBe("2026-08-28T12:00:00.000Z");
  });

  it("is undefined when no intake bookkeeping file exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "foreman-board-data-"));
    const config = makeConfig(stateDir);
    const bookkeeping = readLoopBookkeeping(config);
    expect(bookkeeping.lastRunAt.intake).toBeUndefined();
  });
});
