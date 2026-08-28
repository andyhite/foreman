import { describe, expect, it } from "bun:test";
import type { GlobalConfig } from "@foreman/core";
import { acceptProposal, rejectProposal, resolveBlock } from "../src/actions.ts";
import { handleBlockedKey, initialBlockedScreen } from "../src/screens/blocked.ts";
import { handleProposalsKey, initialProposalsScreen } from "../src/screens/proposals.ts";
import type { BlockedEntry, ProposalEntry } from "../src/data.ts";

/**
 * The board's keypress paths and the two shell-outs they trigger. These are the
 * parts an operator actually touches: pick an option, type a reply, submit,
 * cancel. Every handler here is pure, so the tests drive the real state machine
 * rather than a mock of it.
 */

const ROWS = 10;

function blockedEntry(identifier: string, options: string[]): BlockedEntry {
  return {
    issue: { identifier, title: `Issue ${identifier}` } as BlockedEntry["issue"],
    record: {
      blocked: true,
      type: "needs-decision",
      whatIWasDoing: "Refining the cache eviction criteria.",
      whatINeed: "Which behavior is intended for stale entries?",
      options: options.map((label) => ({ label, tradeoff: `costs ${label}` })),
      recommendation: options[0] ?? null,
      stateLeftBehind: {
        worktree: null,
        branch: null,
        pushed: false,
        commits: [],
        notes: "nothing written",
      },
      costOfWrongGuess: "A wrong guess ships the wrong eviction policy.",
      blockedByIssues: [],
    },
    commentId: `comment-${identifier}`,
  };
}

function proposalEntry(identifier: string): ProposalEntry {
  return {
    issue: { identifier, title: `Issue ${identifier}` } as ProposalEntry["issue"],
    item: {
      issueId: identifier,
      type: "type:bug",
      proposedPriority: 2,
      severityReasoning: "Breaks login for every user.",
      duplicateOf: null,
      proposedBlockedBy: [],
      destination: "Backlog",
      reproConfidence: "confirmed",
      missingInfo: [],
      triageLabel: null,
    },
    commentId: `comment-${identifier}`,
  };
}

describe("blocked drain keys", () => {
  const base = { ...initialBlockedScreen(), entries: [blockedEntry("ENG-1", ["Evict stale", "Keep stale"])] };

  it("resolves with the enumerated option a digit selects", () => {
    const update = handleBlockedKey(base, { kind: "digit", value: 2 }, ROWS);
    expect(update.resolveIssueId).toBe("ENG-1");
    expect(update.resolveReply).toBe("Keep stale");
  });

  it("ignores a digit with no matching option instead of resolving wrongly", () => {
    const update = handleBlockedKey(base, { kind: "digit", value: 7 }, ROWS);
    expect(update.resolveIssueId).toBeNull();
    expect(update.resolveReply).toBeNull();
  });

  it("types a free-text reply and submits it trimmed on Enter", () => {
    let state = handleBlockedKey(base, { kind: "char", value: "n" }, ROWS).state;
    for (const ch of "either  ") state = handleBlockedKey(state, { kind: "char", value: ch }, ROWS).state;
    expect(state.draftReply).toBe("neither  ");

    const submitted = handleBlockedKey(state, { kind: "enter" }, ROWS);
    expect(submitted.resolveIssueId).toBe("ENG-1");
    expect(submitted.resolveReply).toBe("neither");
    expect(submitted.state.draftReply).toBeNull();
  });

  it("treats a digit as text once a draft is open, never as an option pick", () => {
    const drafting = handleBlockedKey(base, { kind: "char", value: "o" }, ROWS).state;
    const update = handleBlockedKey(drafting, { kind: "digit", value: 2 }, ROWS);
    expect(update.resolveIssueId).toBeNull();
    expect(update.state.draftReply).toBe("o2");
  });

  it("refuses to submit a whitespace-only reply", () => {
    const drafting = handleBlockedKey(base, { kind: "char", value: " " }, ROWS).state;
    const update = handleBlockedKey(drafting, { kind: "enter" }, ROWS);
    expect(update.resolveIssueId).toBeNull();
    // The draft survives, so the operator's keystroke is not silently discarded.
    expect(update.state.draftReply).toBe(" ");
  });

  it("cancels a draft on Escape without resolving", () => {
    const drafting = handleBlockedKey(base, { kind: "char", value: "x" }, ROWS).state;
    const update = handleBlockedKey(drafting, { kind: "escape" }, ROWS);
    expect(update.state.draftReply).toBeNull();
    expect(update.resolveIssueId).toBeNull();
  });

  it("erases one character per Backspace", () => {
    let state = handleBlockedKey(base, { kind: "char", value: "a" }, ROWS).state;
    state = handleBlockedKey(state, { kind: "char", value: "b" }, ROWS).state;
    state = handleBlockedKey(state, { kind: "backspace" }, ROWS).state;
    expect(state.draftReply).toBe("a");
  });

  it("does nothing when the drain is empty", () => {
    const empty = initialBlockedScreen();
    expect(handleBlockedKey(empty, { kind: "digit", value: 1 }, ROWS).resolveIssueId).toBeNull();
    expect(handleBlockedKey(empty, { kind: "char", value: "z" }, ROWS).state.draftReply).toBeNull();
  });
});

describe("proposal review keys", () => {
  const base = { ...initialProposalsScreen(), entries: [proposalEntry("ENG-2")] };

  it("accepts on `a`", () => {
    const update = handleProposalsKey(base, { kind: "char", value: "a" }, ROWS);
    expect(update.action).toEqual({ kind: "accept", issueId: "ENG-2" });
  });

  it("opens a reason draft on `r` without acting yet", () => {
    const update = handleProposalsKey(base, { kind: "char", value: "r" }, ROWS);
    expect(update.action).toBeNull();
    expect(update.state.draftReject).toBe("");
  });

  it("rejects with the typed reason on Enter", () => {
    let state = handleProposalsKey(base, { kind: "char", value: "r" }, ROWS).state;
    for (const ch of "wrong type") state = handleProposalsKey(state, { kind: "char", value: ch }, ROWS).state;
    const update = handleProposalsKey(state, { kind: "enter" }, ROWS);
    expect(update.action).toEqual({ kind: "reject", issueId: "ENG-2", reason: "wrong type" });
  });

  it("refuses to reject with an empty reason", () => {
    const state = handleProposalsKey(base, { kind: "char", value: "r" }, ROWS).state;
    expect(handleProposalsKey(state, { kind: "enter" }, ROWS).action).toBeNull();
  });

  it("cancels a reject draft on Escape", () => {
    const state = handleProposalsKey(base, { kind: "char", value: "r" }, ROWS).state;
    const update = handleProposalsKey(state, { kind: "escape" }, ROWS);
    expect(update.state.draftReject).toBeNull();
    expect(update.action).toBeNull();
  });

  it("ignores `a` and `r` when there is nothing selected", () => {
    const empty = initialProposalsScreen();
    expect(handleProposalsKey(empty, { kind: "char", value: "a" }, ROWS).action).toBeNull();
    expect(handleProposalsKey(empty, { kind: "char", value: "r" }, ROWS).state.draftReject).toBeNull();
  });
});

describe("shell-outs", () => {
  const config = {
    agent: { ompBin: "/usr/local/bin/omp", approvalMode: "yolo" },
  } as GlobalConfig;

  function capture() {
    const calls: Array<{ bin: string; args: string[] }> = [];
    return {
      calls,
      runCommand: async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  it("routes an unblock through omp print mode with an explicit approval mode", async () => {
    const { calls, runCommand } = capture();
    const result = await resolveBlock({ config, runCommand }, "ENG-1", "Keep stale");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("/usr/local/bin/omp");
    expect(calls[0]?.args).toEqual([
      "-p",
      "--approval-mode",
      "yolo",
      "/foreman:unblock ENG-1 Keep stale",
    ]);
  });

  it("builds the per-item approve and reject shapes", async () => {
    const { calls, runCommand } = capture();
    await acceptProposal({ config, runCommand }, "ENG-2");
    await rejectProposal({ config, runCommand }, "ENG-3", "wrong type");
    expect(calls.map((c) => c.args[3])).toEqual([
      "/foreman:apply ENG-2 --approve",
      "/foreman:apply ENG-3 --reject wrong type",
    ]);
  });

  it("reports failure rather than claiming success when the command exits non-zero", async () => {
    const result = await resolveBlock(
      {
        config,
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "no such issue" }),
      },
      "ENG-9",
      "whatever",
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("no such issue");
  });
});
