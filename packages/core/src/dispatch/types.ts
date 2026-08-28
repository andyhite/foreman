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
  /** Working directory for the launched session. The issue's worktree, when it has one. */
  cwd: string;
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
  /** True when this dispatcher's substrate is reachable right now. */
  available(): Promise<boolean>;
}
