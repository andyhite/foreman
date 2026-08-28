import { describe, expect, it } from "bun:test";
import { parseAgentList } from "../src/screens/agents.ts";

/**
 * Captured verbatim from `herdr agent list` on herdr 0.8.2. The envelope and
 * the `agent_status` spelling are the two things this parser got wrong twice:
 * once reading the payload as a bare array, once expecting a `name` field and
 * a `status` field that do not exist. Keep this fixture as-is — trimming it to
 * "just the interesting keys" would stop it from catching the next drift.
 */
const REAL_PAYLOAD = JSON.stringify({
  id: "cli:agent:list",
  result: {
    agents: [
      {
        agent: "omp",
        agent_session: {
          agent: "omp",
          kind: "path",
          source: "herdr:omp",
          value: "/Users/u/.omp/agent/sessions/-Code-x/2026-08-27T04-59-43-893Z_01a04196.jsonl",
        },
        agent_status: "idle",
        cwd: "/Users/u/Code/dotfiles",
        focused: false,
        foreground_cwd: "/Users/u/Code/dotfiles",
        pane_id: "w95:pE",
        revision: 34567,
        screen_detection_skipped: true,
        state_change_seq: 1711,
        tab_id: "w95:t1",
        terminal_id: "term_659f864b1181f60",
        terminal_title: "\u03c0 > dotfiles",
        terminal_title_stripped: "\u03c0 > dotfiles",
        title: "remove foreman from our omp plugins",
        tokens: { age: "1d18h", rank: "3", since: "1d9h", title: "\u03c0 > dotfiles" },
        workspace_id: "w95",
      },
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/Users/u/Code/foreman",
        focused: true,
        pane_id: "w95:pF",
        tab_id: "w95:t2",
        title: "implement the review gate",
        workspace_id: "w95",
      },
    ],
  },
});

describe("parseAgentList", () => {
  it("reads the real herdr 0.8.2 envelope", () => {
    const agents = parseAgentList(REAL_PAYLOAD);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({
      paneId: "w95:pE",
      kind: "omp",
      status: "idle",
      title: "remove foreman from our omp plugins",
      cwd: "/Users/u/Code/dotfiles",
      focused: false,
      workspaceId: "w95",
    });
    expect(agents[1]?.status).toBe("working");
    expect(agents[1]?.focused).toBe(true);
  });

  it("returns nothing for a bare array, which is what the old parser assumed", () => {
    expect(parseAgentList(JSON.stringify([{ pane_id: "w1:p1", agent_status: "idle" }]))).toEqual([]);
  });

  it("maps an unrecognized state to unknown rather than treating it as finished", () => {
    const payload = JSON.stringify({
      result: { agents: [{ pane_id: "w1:p1", agent_status: "reticulating" }] },
    });
    expect(parseAgentList(payload)[0]?.status).toBe("unknown");
  });

  it("drops a row with no pane id, since pane id is the only usable target", () => {
    const payload = JSON.stringify({
      result: { agents: [{ agent: "omp", agent_status: "idle" }, { pane_id: "w1:p1" }] },
    });
    const agents = parseAgentList(payload);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.paneId).toBe("w1:p1");
    // A present row with an absent status is `unknown`, never `done`.
    expect(agents[0]?.status).toBe("unknown");
  });

  it("degrades to empty on malformed json and on a missing result envelope", () => {
    expect(parseAgentList("not json")).toEqual([]);
    expect(parseAgentList(JSON.stringify({ agents: [] }))).toEqual([]);
    expect(parseAgentList(JSON.stringify({ result: {} }))).toEqual([]);
  });
});
