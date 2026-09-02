/**
 * Dispatchers (SPEC §17.2).
 *
 * The scheduler decides *what* to run. How a spawn is launched is a separate,
 * swappable concern, because herdr is the better daily driver but is a stateful
 * dependency in the dispatch path — Foreman must degrade to print mode when the
 * server is absent rather than stalling the loop.
 *
 * This lives in `core` rather than in the plugin because both the loop and the
 * extension launch dispatches, and `core` exists precisely so a thing two
 * consumers need is not written twice.
 */

import type { ForemanAgentName } from "../schemas/index.ts";

export type DispatchStatus = "starting" | "running" | "settled" | "lost";

export interface DispatchRequest {
  agent: ForemanAgentName;
  /** Human identifier, e.g. `ENG-142`. Absent for the triage batch. */
  issueId: string | null;
  /** The slash command to run, exactly as the operator would type it. */
  command: string;
  /** Claimed by the extension before the spawn; the agent verifies it (SPEC §11). */
  dispatchId: string;
  /** Working directory for the launched session — always the repo checkout, never a worktree; see `worktree` for that. */
  cwd: string;
  /**
   * Set only for dispatches that write code: the isolated git worktree this
   * run belongs in. `HerdrDispatcher` opens a dedicated worktree-backed
   * workspace for it instead of grouping into a shared per-stage tab; other
   * dispatchers ignore it and just use `cwd`.
   */
  worktree: { path: string; branch: string; baseBranch: string } | null;
}

export interface DispatchHandle {
  dispatchId: string;
  agent: ForemanAgentName;
  issueId: string | null;
  startedAt: string;
  /** Set by the print dispatcher. */
  pid: number | null;
  /** Set by the herdr dispatcher: `<workspace>:<tab>:<pane>` plus the agent alias. */
  herdr: { paneId: string; agentName: string } | null;
}

export interface DispatchOutcome {
  handle: DispatchHandle;
  status: DispatchStatus;
  exitCode: number | null;
  /** Combined stdout/stderr for print dispatch; empty for herdr. */
  log: string;
}

export interface Dispatcher {
  readonly kind: "print" | "herdr";
  dispatch(request: DispatchRequest): Promise<DispatchHandle>;
  status(handle: DispatchHandle): Promise<DispatchStatus>;
  /** Resolves when the launched session exits. Print mode only. */
  settle(handle: DispatchHandle): Promise<DispatchOutcome>;
  /** herdr only: bring the operator to the pane. */
  attach?(handle: DispatchHandle): Promise<void>;
  /**
   * Post-merge housekeeping (SPEC §12): release whatever terminal state this
   * dispatcher holds for the issue — herdr closes the issue's worktree
   * workspace when it had one; print mode has nothing to release and leaves
   * this unimplemented.
   */
  cleanup?(issueId: string, repoPath: string, worktreePath: string | null): Promise<void>;
  /** True when this dispatcher's substrate is reachable right now. */
  available(): Promise<boolean>;
}
