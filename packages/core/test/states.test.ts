import { describe, expect, it } from "bun:test";
import { FOREMAN_STATE, StateResolutionError, resolveState } from "../src/domain/states.ts";
import type { WorkflowState } from "../src/linear/types.ts";

describe("resolveState", () => {
  it("throws StateResolutionError naming foreman doctor --fix when no state matches by name", () => {
    const states: WorkflowState[] = [{ id: "s-todo", name: "Todo", type: "unstarted", position: 1 }];
    expect(() => resolveState("ready", states)).toThrow(StateResolutionError);
    try {
      resolveState("ready", states);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StateResolutionError);
      expect((error as StateResolutionError).message).toContain("foreman doctor --fix");
    }
  });

  it("resolves by exact name, no category fallback", () => {
    const ready: WorkflowState = { id: "s-ready", name: "Ready", type: "unstarted", position: 2 };
    const states: WorkflowState[] = [{ id: "s-todo", name: "Todo", type: "unstarted", position: 1 }, ready];
    expect(resolveState("ready", states)).toEqual(ready);
  });

  it("resolves triage by state type despite a renamed triage state", () => {
    const inbox: WorkflowState = { id: "s-inbox", name: "Inbox", type: "triage", position: 0 };
    const states: WorkflowState[] = [
      inbox,
      { id: "s-backlog", name: "Backlog", type: "backlog", position: 1 },
    ];
    expect(resolveState("triage", states)).toEqual(inbox);
  });

  it("throws for triage when no state has type triage, even if one is named Triage", () => {
    const states: WorkflowState[] = [{ id: "s-triage", name: "Triage", type: "backlog", position: 0 }];
    expect(() => resolveState("triage", states)).toThrow(StateResolutionError);
  });

  it("matches every non-triage FOREMAN_STATE key case-insensitively and trimmed", () => {
    const states: WorkflowState[] = [{ id: "s-review", name: "  in review  ", type: "started", position: 5 }];
    expect(resolveState("inReview", states).id).toBe("s-review");
    expect(FOREMAN_STATE.inReview).toBe("In Review");
  });
});
