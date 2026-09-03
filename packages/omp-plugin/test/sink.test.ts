import { describe, expect, it } from "bun:test";
import { isBudgetTruncation } from "@foreman/core";
import {
  extractFromToolResult,
  sink,
  type AppliedTracker,
  type CapturedOutput,
} from "../src/results/sink.ts";

describe("extractFromToolResult", () => {
  // Every payload below is the shape the runtime actually emits, measured
  // against a live `tool_result` (docs/VERIFIED.md): `details` flat on the
  // event next to `content`/`isError`, with no enclosing `result` field, and
  // `structuredOutput` as `{ source, mode, status, data }` - no `valid`
  // boolean. Both fabrications silently dropped every genuine result.
  it("extracts structuredOutput from a tool_result-shaped payload", () => {
    const payload = {
      toolName: "task",
      toolCallId: "call-1",
      input: {
        tasks: [{ agent: "foreman-implement", task: "Implement.\n\nFOREMAN-DISPATCH: foreman-implement-ENG-1-1\n" }],
      },
      details: {
        results: [
          {
            structuredOutput: { source: "agent", mode: "strict", status: "valid", data: { issueId: "ENG-1" } },
          },
        ],
      },
    };
    const captured = extractFromToolResult(payload);
    expect(captured).toEqual([
      {
        dispatchId: "foreman-implement-ENG-1-1",
        agent: "foreman-implement",
        data: { issueId: "ENG-1" },
        aborted: false,
        issueId: null,
        previousStateId: null,
      },
    ]);
  });

  it("still captures a status: invalid structuredOutput — a budget-truncated yield must reach the classifier downstream", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-implement", task: "FOREMAN-DISPATCH: d-1\n" }] },
      details: {
        results: [
          { structuredOutput: { source: "agent", mode: "strict", status: "invalid", data: {}, error: "schema_violation" } },
        ],
      },
    };
    const captured = extractFromToolResult(payload);
    expect(captured).toEqual([
      { dispatchId: "d-1", agent: "foreman-implement", data: {}, aborted: false, issueId: null, previousStateId: null },
    ]);
  });

  it("captures a status: unavailable structuredOutput so a broken schema surfaces as an invalid result rather than silence", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-plan", task: "FOREMAN-DISPATCH: d-2\n" }] },
      details: { results: [{ structuredOutput: { source: "agent", mode: "strict", status: "unavailable", data: null } }] },
    };
    expect(extractFromToolResult(payload).map((item) => item.dispatchId)).toEqual(["d-2"]);
  });

  it("ignores results whose structuredOutput carries no recognizable status", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-implement", task: "FOREMAN-DISPATCH: d-1\n" }] },
      details: { results: [{ structuredOutput: { notAStructuredOutput: true } }] },
    };
    expect(extractFromToolResult(payload)).toEqual([]);
  });

  it("ignores a task result whose text carries no FOREMAN-DISPATCH marker", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-plan", task: "FOREMAN-PROJECT: project-1\n" }] },
      details: { results: [{ structuredOutput: { source: "agent", mode: "strict", status: "valid", data: {} } }] },
    };
    expect(extractFromToolResult(payload)).toEqual([]);
  });

  it("ignores a non-task tool_result", () => {
    expect(extractFromToolResult({ toolName: "read", details: {} })).toEqual([]);
  });

  // The shape this asserts is dead is the one the plugin used to read: an
  // enclosing `result` field the runtime never emits. Every stage's result
  // was dropped in silence, so the absence has to stay asserted.
  it("captures nothing from a payload whose details hide under a `result` field", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-plan", task: "FOREMAN-DISPATCH: d-3\n" }] },
      result: {
        content: [],
        details: { results: [{ structuredOutput: { source: "agent", mode: "strict", status: "valid", data: {} } }] },
      },
    };
    expect(extractFromToolResult(payload)).toEqual([]);
  });
});

describe("sink — idempotency", () => {
  function makeTracker(applied: Set<string>): AppliedTracker {
    return { wasApplied: async (dispatchId: string) => applied.has(dispatchId) };
  }

  it("is a no-op on a second delivery of the same dispatch id", async () => {
    const applied = new Set<string>();
    const calls: CapturedOutput[] = [];
    const captured: CapturedOutput = { dispatchId: "d-1", agent: "foreman-implement", data: {}, aborted: false, issueId: "ENG-1", previousStateId: null };

    await sink(captured, makeTracker(applied), async (value) => {
      calls.push(value);
      applied.add(value.dispatchId);
    });
    await sink(captured, makeTracker(applied), async (value) => {
      calls.push(value);
    });

    expect(calls.length).toBe(1);
  });

  it("forwards the captured agent to wasApplied, so a tracker can skip a project-scoped dispatch id's issue lookup", async () => {
    const seenAgents: string[] = [];
    const tracker: AppliedTracker = {
      wasApplied: async (_dispatchId, agent) => {
        seenAgents.push(agent);
        return false;
      },
    };
    const captured: CapturedOutput = { dispatchId: "d-1", agent: "foreman-plan", data: {}, aborted: false, issueId: null, previousStateId: null };

    await sink(captured, tracker, async () => {});

    expect(seenAgents).toEqual(["foreman-plan"]);
  });
});

describe("routing invalid results through the block path", () => {
  // `isBudgetTruncation` lives in `@foreman/core`; the sink's responsibility
  // ends at handing the caller a `CapturedOutput` — routing an invalid,
  // budget-aborted result to `applyBlock` vs. a hard failure happens in the
  // extension's channel handler, which calls `parseAgentOutput` then
  // `isBudgetTruncation` on the result before ever reaching `sink`.
  it("aborted: true is distinguishable from aborted: false by the caller", () => {
    expect(isBudgetTruncation({ aborted: true, problems: ["truncated"] })).toBe(true);
    expect(isBudgetTruncation({ aborted: false, problems: ["truncated"] })).toBe(false);
  });
});
