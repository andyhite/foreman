/**
 * Shared builders for the view-layer test suite (`views.test.ts`).
 *
 * Every view renders from a `LoopSnapshot` plus `AppState`, and both are
 * large, deeply-nested, mostly-non-null shapes — a view that only ever sees
 * a hand-trimmed fixture never exercises the branch that reads a field the
 * fixture happened to omit. `makeSnapshot` is therefore fully populated:
 * every array has at least one entry and every nullable field is exercised
 * by at least one row, so a view that forgets a null guard fails a render
 * test here instead of wedging the real TUI later.
 */

import type {
  AgentView,
  GlobalConfig,
  Key,
  LoopHandle,
  LoopPaths,
  LoopSnapshot,
  Theme,
} from "@foreman/core";
import { createTheme, decodeKeys, defaultAndValidateGlobalConfig } from "@foreman/core";
import {
  type Action,
  type AppState,
  initialState,
  reduce,
  resetToastIdForTest,
  type LoopPane,
} from "../src/store.ts";
import { VIEW_IDS } from "../src/view.ts";
import type { ViewContext } from "../src/view.ts";

const NOW = 1_700_000_000_000;

function loopPaths(dir: string): LoopPaths {
  return {
    dir,
    lock: `${dir}/loop.lock`,
    bookkeeping: `${dir}/bookkeeping.json`,
    status: `${dir}/status.json`,
    socket: `${dir}/control.sock`,
    log: `${dir}/loop.log`,
  };
}

export function makeSnapshot(overrides?: Partial<LoopSnapshot>): LoopSnapshot {
  const base: LoopSnapshot = {
    loop: {
      id: "repo:demo",
      kind: "repo",
      label: "demo",
      alias: "demo",
      team: "acme",
      repoPath: "/Users/user/Code/acme/demo",
      initiativeIds: ["INIT-1", "INIT-2"],
      pid: 4242,
      startedAt: "2026-08-29T00:00:00.000Z",
      version: "1.2.3",
    },
    runtime: {
      state: "running",
      stage: "full",
      dryRun: false,
      dispatcher: "herdr",
      pausedAt: null,
      lastTickAt: "2026-08-29T00:05:00.000Z",
      nextTickAt: "2026-08-29T00:10:00.000Z",
      ticks: 42,
      uptimeMs: 3_600_000,
    },
    workers: [
      {
        name: "reaper",
        cadenceMs: 60_000,
        lastRunAt: "2026-08-29T00:04:00.000Z",
        nextRunAt: "2026-08-29T00:05:00.000Z",
        running: false,
        dispatched: 0,
        skipped: 3,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
      {
        name: "plan",
        cadenceMs: 120_000,
        lastRunAt: "2026-08-29T00:03:00.000Z",
        nextRunAt: "2026-08-29T00:05:00.000Z",
        running: false,
        dispatched: 1,
        skipped: 0,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
      {
        name: "refine",
        cadenceMs: 120_000,
        lastRunAt: "2026-08-29T00:02:00.000Z",
        nextRunAt: "2026-08-29T00:05:00.000Z",
        running: true,
        dispatched: 2,
        skipped: 1,
        errors: 1,
        lastSkips: [
          { issueId: "ENG-101", code: "not-ready", message: "missing acceptance criteria" },
        ],
        lastError: "refine worker crashed: timeout contacting Linear",
      },
      {
        name: "implement",
        cadenceMs: 60_000,
        lastRunAt: "2026-08-29T00:04:30.000Z",
        nextRunAt: "2026-08-29T00:05:30.000Z",
        running: true,
        dispatched: 5,
        skipped: 0,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
      {
        name: "review",
        cadenceMs: 60_000,
        lastRunAt: null,
        nextRunAt: "2026-08-29T00:06:00.000Z",
        running: false,
        dispatched: 0,
        skipped: 0,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
      {
        name: "merge-detect",
        cadenceMs: 300_000,
        lastRunAt: "2026-08-29T00:00:00.000Z",
        nextRunAt: null,
        running: false,
        dispatched: 3,
        skipped: 0,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
      {
        name: "project-status",
        cadenceMs: 300_000,
        lastRunAt: "2026-08-29T00:01:00.000Z",
        nextRunAt: "2026-08-29T00:06:00.000Z",
        running: false,
        dispatched: 1,
        skipped: 0,
        errors: 0,
        lastSkips: [],
        lastError: null,
      },
    ],
    agents: [
      {
        dispatchId: "dispatch-1",
        agent: "foreman-implement",
        stage: "implement",
        issueId: "ENG-201",
        projectId: "proj-1",
        startedAt: "2026-08-29T00:01:00.000Z",
        ageMs: 240_000,
        status: "running",
        herdr: { paneId: "herdr-pane-7", agentName: "implement-7" },
        pid: 5150,
        worktree: "/Users/user/Code/acme/demo-worktrees/ENG-201",
        ttlMs: 3_600_000,
        pastTtl: false,
      },
      {
        dispatchId: "dispatch-2",
        agent: "foreman-review",
        stage: "review",
        issueId: "ENG-202",
        projectId: null,
        startedAt: "2026-08-29T00:00:00.000Z",
        ageMs: 7_200_000,
        status: "lost",
        herdr: null,
        pid: null,
        worktree: null,
        ttlMs: 3_600_000,
        pastTtl: true,
      },
    ],
    wip: {
      global: { used: 2, cap: 3 },
      byStage: [
        { stage: "plan", used: 0, cap: 1 },
        { stage: "refine", used: 1, cap: 2 },
        { stage: "implement", used: 1, cap: 2 },
        { stage: "review", used: 0, cap: 1 },
      ],
    },
    backpressure: {
      tripped: true,
      blockedCount: 5,
      threshold: 3,
      reason: "blocked queue depth 5 exceeds threshold 3",
    },
    board: {
      backlog: 12,
      todo: 4,
      inProgress: 2,
      inReview: 1,
      blocked: 2,
      proposals: 3,
      readyBuffer: 2,
      triageInbox: 6,
    },
    queues: {
      blocked: [
        {
          issueId: "ENG-301",
          title: "Pick a retry strategy",
          type: "decision",
          question: "Should the retry backoff be linear or exponential once the retry cap is raised?",
          detectedAt: "2026-08-29T00:02:00.000Z",
          options: [
            { label: "linear", tradeoff: "simple, but slower to back off under sustained failure" },
            { label: "exponential", tradeoff: "recovers faster, but harder to reason about in logs" },
          ],
          recommendation: "exponential",
        },
        {
          issueId: "ENG-302",
          title: "Undocumented external dependency",
          type: "spike",
          question: "The vendor API has no documented rate limit — what should we assume?",
          detectedAt: null,
          options: [],
          recommendation: null,
        },
      ],
      proposals: [
        {
          issueId: "ENG-401",
          title: "Add a health check endpoint",
          destination: "Backlog",
          proposedPriority: 2,
          duplicateOf: null,
          proposedAt: "2026-08-29T00:03:00.000Z",
        },
        {
          issueId: "ENG-402",
          title: "Investigate flaky test",
          destination: "Duplicate",
          proposedPriority: null,
          duplicateOf: "ENG-105",
          proposedAt: "2026-08-29T00:04:00.000Z",
        },
        {
          issueId: "ENG-403",
          title: "Stale low-priority cleanup task",
          destination: "Canceled",
          proposedPriority: null,
          duplicateOf: null,
          proposedAt: "2026-08-29T00:05:00.000Z",
        },
      ],
      decisions: [
        {
          issueId: "ENG-501",
          stage: "review",
          kind: "review-cycle-exhausted",
          attempts: 3,
          detectedAt: "2026-08-29T00:06:00.000Z",
        },
      ],
      pipeline: [
        {
          issueId: "ENG-601",
          title: "Backlog item with no estimate",
          state: "Backlog",
          priority: 0,
          estimate: null,
          labels: ["bug"],
          assignee: null,
          updatedAt: "2026-08-29T00:01:00.000Z",
          url: "https://linear.app/acme/issue/ENG-601",
        },
        {
          issueId: "ENG-602",
          title: "Todo item, urgent",
          state: "Todo",
          priority: 1,
          estimate: 2,
          labels: ["urgent", "backend"],
          assignee: "ada",
          updatedAt: "2026-08-29T00:02:00.000Z",
          url: "https://linear.app/acme/issue/ENG-602",
        },
        {
          issueId: "ENG-603",
          title: "In progress, high priority",
          state: "In Progress",
          priority: 2,
          estimate: 5,
          labels: ["frontend"],
          assignee: "grace",
          updatedAt: "2026-08-29T00:03:00.000Z",
          url: "https://linear.app/acme/issue/ENG-603",
        },
        {
          issueId: "ENG-604",
          title: "In review, medium priority",
          state: "In Review",
          priority: 3,
          estimate: 1,
          labels: ["backend", "urgent", "infra"],
          assignee: "linus",
          updatedAt: "2026-08-29T00:04:00.000Z",
          url: "https://linear.app/acme/issue/ENG-604",
        },
        {
          issueId: "ENG-605",
          title: "Low priority polish",
          state: "Todo",
          priority: 4,
          estimate: 3,
          labels: [],
          assignee: null,
          updatedAt: "2026-08-29T00:05:00.000Z",
          url: "https://linear.app/acme/issue/ENG-605",
        },
      ],
    },
    linear: {
      ok: true,
      lastPollAt: "2026-08-29T00:05:00.000Z",
      lastError: null,
      requests: 128,
    },
    history: {
      dispatchesPerTick: Array.from({ length: 20 }, (_, i) => Math.abs(Math.round(Math.sin(i) * 5))),
    },
  };
  return { ...base, ...overrides };
}

export function makeIntakeSnapshot(): LoopSnapshot {
  return makeSnapshot({
    loop: {
      id: "intake",
      kind: "intake",
      label: "intake",
      alias: null,
      team: "acme",
      repoPath: null,
      initiativeIds: [],
      pid: 4300,
      startedAt: "2026-08-29T00:00:00.000Z",
      version: "1.2.3",
    },
  });
}

export function makeHandle(id: string, overrides?: Partial<LoopHandle>): LoopHandle {
  const kind = id === "intake" ? "intake" : "repo";
  const alias = kind === "intake" ? null : id.startsWith("repo:") ? id.slice("repo:".length) : id;
  const base: LoopHandle = {
    id,
    kind,
    label: alias ?? "intake",
    alias,
    repoPath: kind === "intake" ? null : `/Users/user/Code/acme/${alias}`,
    paths: loopPaths(`/tmp/foreman-state/${alias ?? "intake"}`),
    running: true,
    pid: 4242,
    startedAt: "2026-08-29T00:00:00.000Z",
    reachable: true,
    status: null,
    staleStatus: false,
  };
  return { ...base, ...overrides };
}

export function makeState(overrides?: Partial<AppState>): AppState {
  resetToastIdForTest();
  const config: GlobalConfig = defaultAndValidateGlobalConfig({}, "views.test.ts fixture");
  const state = initialState({
    config,
    configPath: "/Users/user/.foreman/config.json",
    repoAlias: "demo",
    team: "acme",
    viewIds: VIEW_IDS,
    now: NOW,
  });
  return { ...state, ...overrides };
}

function makePane(id: string, snapshot: LoopSnapshot, overrides?: Partial<LoopPane>): LoopPane {
  const handle = makeHandle(id);
  const base: LoopPane = {
    id: handle.id,
    kind: handle.kind,
    label: handle.label,
    handle,
    snapshot,
    connection: "live",
    error: null,
    busy: null,
  };
  return { ...base, ...overrides };
}

/** Two panes: `repo:demo` live with `makeSnapshot()`, `intake` live with `makeIntakeSnapshot()`. */
export function makeLiveState(): AppState {
  return makeState({
    loops: [makePane("repo:demo", makeSnapshot()), makePane("intake", makeIntakeSnapshot())],
    focusedLoop: 0,
  });
}

/** Same two panes, but neither has ever connected — the "loop not running" branch of every view. */
export function makeOfflineState(): AppState {
  return makeState({
    loops: [
      makePane("repo:demo", makeSnapshot(), { snapshot: null, connection: "offline" }),
      makePane("intake", makeIntakeSnapshot(), { snapshot: null, connection: "offline" }),
    ],
    focusedLoop: 0,
  });
}

/** Records every call so a test can assert what a keypress did. */
export interface RecordingContext extends ViewContext {
  readonly calls: string[];
  readonly actions: Action[];
}

export function makeContext(state: AppState, theme?: Theme): RecordingContext {
  let current = state;
  const calls: string[] = [];
  const actions: Action[] = [];

  return {
    get state() {
      return current;
    },
    theme: theme ?? createTheme(false),
    tick: 0,
    calls,
    actions,
    dispatch(action) {
      calls.push(`dispatch:${action.type}`);
      actions.push(action);
      current = reduce(current, action);
    },
    async command(loopId, op) {
      calls.push(`command:${loopId}:${op}`);
      return true;
    },
    startLoop(loopId) {
      calls.push(`startLoop:${loopId}`);
    },
    toast(kind, message) {
      calls.push(`toast:${kind}:${message}`);
    },
    async suspend(fn) {
      calls.push("suspend");
      return fn();
    },
    requestRender() {
      calls.push("requestRender");
    },
    openUrl(url) {
      calls.push(`openUrl:${url}`);
    },
  };
}

const NAMED_KEY_BYTES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  space: " ",
};

function decodeExactlyOne(bytes: string, spec: string): Key {
  const decoded = decodeKeys(bytes);
  if (decoded.length !== 1) {
    throw new Error(`key(${JSON.stringify(spec)}) decoded to ${decoded.length} keys, expected exactly 1`);
  }
  return decoded[0]!;
}

/**
 * Builds a `Key` from a spec string like `"up"`, `"enter"`, `"ctrl-s"`, `"?"`,
 * `"j"`. Drives `decodeKeys` on the real byte sequence wherever one exists —
 * that is what actually catches a `decodeKeys` regression — and only falls
 * back to a plain object literal for specs that have no natural byte form.
 */
export function key(spec: string): Key {
  if (spec.startsWith("ctrl-") && spec.length === "ctrl-x".length) {
    const letter = spec.slice(5).toLowerCase();
    const code = letter.charCodeAt(0) - 96;
    if (code < 1 || code > 26) throw new Error(`key(): unsupported ctrl spec "${spec}"`);
    return decodeExactlyOne(String.fromCharCode(code), spec);
  }
  const named = NAMED_KEY_BYTES[spec];
  if (named !== undefined) {
    return decodeExactlyOne(named, spec);
  }
  if (spec.length >= 1) {
    return decodeExactlyOne(spec, spec);
  }
  throw new Error(`key(): unsupported spec "${spec}"`);
}
