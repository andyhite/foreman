/**
 * Dispatchers (SPEC §17.2, §17.4).
 *
 * The scheduler decides *what* to run. How a spawn is launched is a separate,
 * swappable concern, because herdr is the better daily driver but is a stateful
 * dependency in the dispatch path — Foreman must degrade to print mode when the
 * server is absent rather than stalling the loop.
 *
 * A dispatch carries a *batch* of items rather than one, because the parent
 * session a dispatcher launches is only a shim: it turns the slash command into
 * one `task` call, and every `foreman-*` agent declares `blocking: true` so its
 * structured output lands in that call's `tool_result` (the only channel omp
 * populates with structured data — `packages/omp-plugin/src/results/sink.ts`).
 * One call with N blocking items therefore runs N agents concurrently and
 * captures N results, which is what lets a whole stage share a single
 * long-lived orchestrator session instead of booting one per issue (SPEC §17.4).
 *
 * This lives in `core` rather than in the plugin because both the loop and the
 * extension launch dispatches, and `core` exists precisely so a thing two
 * consumers need is not written twice.
 */


export type DispatchStatus = "starting" | "running" | "settled" | "lost";

/** The reservation subject the triage batch dispatches under — it names no issue and no project. */
export const BATCH_SUBJECT = "batch";

export interface DispatchItem {
  /** Human identifier, e.g. `ENG-142`. Absent for the triage batch and for plan, which operates on a project. */
  issueId: string | null;
  /**
   * The argument the slash command takes for this item — an issue identifier,
   * a project id, or `null` for triage, which takes none. The dispatcher
   * appends every non-null subject to `command`, so this is also what the
   * agent's task guard matches a reservation on.
   */
  subject: string | null;
  /** Claimed by the loop before the spawn; the agent's task guard verifies it (SPEC §11). */
  dispatchId: string;
  /**
   * Set only for items that write code: the isolated git worktree this item
   * belongs in. An item with a worktree is dispatched to its own per-issue
   * agent in a worktree-backed workspace rather than to the stage's shared
   * orchestrator, because a non-isolated subagent inherits its parent
   * session's cwd and would otherwise write in the repo root (SPEC §17.4).
   * Such a request carries exactly one item.
   */
  worktree: { path: string; branch: string; baseBranch: string } | null;
}

export interface DispatchRequest {
  agent: string;
  /**
   * The slash command with no arguments, e.g. `/foreman:refine`. The
   * dispatcher appends the items' subjects, so this is the one place the
   * command text is assembled and workers never build an argument list.
   */
  command: string;
  /** Working directory for the launched session — always the repo checkout, never a worktree; see `DispatchItem.worktree` for that. */
  cwd: string;
  /**
   * Namespace for the stage's shared orchestrator: the repo registry alias,
   * or `intake` for the team loop. herdr agent names must be unique among
   * live agents, so two loops on one machine must not derive the same name
   * for their refine orchestrators (SPEC §3.10, §17.4).
   */
  alias: string;
  /** At least one. Items in one request share one agent session and one `task` call. */
  items: readonly DispatchItem[];
}

export interface DispatchHandle {
  dispatchId: string;
  agent: string;
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
  /** One handle per item, in request order. */
  dispatch(request: DispatchRequest): Promise<DispatchHandle[]>;
  status(handle: DispatchHandle): Promise<DispatchStatus>;
  /** Resolves when the batch's turn finishes. */
  settle(handle: DispatchHandle): Promise<DispatchOutcome>;
  /**
   * Post-merge housekeeping (SPEC §12): release whatever terminal state this
   * dispatcher holds for the issue — herdr closes the issue's worktree
   * workspace when it had one; print mode has nothing to release and leaves
   * this unimplemented. Never touches a stage's shared orchestrator, which
   * outlives every issue that passed through it.
   */
  cleanup?(issueId: string, repoPath: string, worktreePath: string | null): Promise<void>;
  /** Best-effort: ask a live dispatch to stop. Optional — a dispatcher with no way to signal its agent (herdr, whose pane the operator may still want) simply omits it. */
  abort?(handle: DispatchHandle): Promise<void>;
  /** True when this dispatcher's substrate is reachable right now. */
  available(): Promise<boolean>;
}
