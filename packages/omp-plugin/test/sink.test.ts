import { describe, expect, it } from "bun:test";
import { isBudgetTruncation } from "@foreman/core";
import {
  extractFromLifecycle,
  extractFromToolResult,
  sink,
  type AppliedTracker,
  type CapturedOutput,
} from "../src/results/sink.ts";

describe("extractFromToolResult", () => {
  it("extracts structuredOutput from a tool_result-shaped payload", () => {
    const payload = {
      toolName: "task",
      toolCallId: "call-1",
      input: {
        tasks: [{ agent: "foreman-implement", task: "Implement.\n\nFOREMAN-DISPATCH: foreman-implement-ENG-1-1\n" }],
      },
      result: {
        content: [],
        details: {
          results: [
            {
              structuredOutput: { data: { issueId: "ENG-1" }, valid: true, mode: "strict", source: "yield", error: null },
            },
          ],
        },
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

  it("still captures a runtime-invalid (valid: false) structuredOutput — a budget-truncated yield must reach the classifier downstream", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-implement", task: "FOREMAN-DISPATCH: d-1\n" }] },
      result: { content: [], details: { results: [{ structuredOutput: { data: {}, valid: false } }] } },
    };
    const captured = extractFromToolResult(payload);
    expect(captured).toEqual([
      { dispatchId: "d-1", agent: "foreman-implement", data: {}, aborted: false, issueId: null, previousStateId: null },
    ]);
  });

  it("ignores results whose structuredOutput is malformed (missing the valid/data shape)", () => {
    const payload = {
      toolName: "task",
      input: { tasks: [{ agent: "foreman-implement", task: "FOREMAN-DISPATCH: d-1\n" }] },
      result: { content: [], details: { results: [{ structuredOutput: { notAStructuredOutput: true } }] } },
    };
    expect(extractFromToolResult(payload)).toEqual([]);
  });

  it("ignores a non-task tool_result", () => {
    expect(extractFromToolResult({ toolName: "read", result: {} })).toEqual([]);
  });
});

describe("extractFromLifecycle", () => {
  it("extracts structuredOutput from a bare lifecycle-shaped payload", () => {
    const payload = {
      agent: "foreman-refine",
      dispatchId: "foreman-refine-ENG-2-9",
      structuredOutput: { data: { issueId: "ENG-2" }, valid: true },
    };
    expect(extractFromLifecycle(payload)).toEqual({
      dispatchId: "foreman-refine-ENG-2-9",
      agent: "foreman-refine",
      data: { issueId: "ENG-2" },
      aborted: false,
      issueId: null,
      previousStateId: null,
    });
  });

  it("recovers the dispatch id from FOREMAN-DISPATCH markers when no explicit field is present", () => {
    const payload = {
      agent: "foreman-review",
      task: "Review it.\n\nFOREMAN-DISPATCH: foreman-review-ENG-3-1\n",
      structuredOutput: { data: { issueId: "ENG-3" }, valid: true },
    };
    expect(extractFromLifecycle(payload)?.dispatchId).toBe("foreman-review-ENG-3-1");
  });

  it("returns null for a payload with no recognizable structuredOutput", () => {
    expect(extractFromLifecycle({ agent: "foreman-review", note: "just progress" })).toBeNull();
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
