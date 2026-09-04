/**
 * `tool_call` interceptor for `task` (SPEC §3.5 item 3, §6, §11, §17.5).
 *
 * This is the sole dispatch-preparation point: it forces strict schema
 * validation onto every `foreman-*` spawn, strips isolation (SPEC §3.7),
 * evaluates the stage's gate, claims the lock, prepares the worktree/diff,
 * and appends the machine-readable `FOREMAN-*` markers the agent and the
 * result appliers both read back. `prepareTaskCall` takes its dependencies
 * as a parameter so it is testable without a running omp session.
 */

import type { GateResult, GlobalConfig, Issue, LinearWriter } from "@foreman/core";
import type { GitHubClient, EnsureWorktreeResult, ResolvedRepoEntry } from "@foreman/core";
import {
  AGENT_OUTPUT_SCHEMAS,
  assertIssueInScope,
  branchNameFor,
  diffRange,
  FOREMAN_STATE,
  gateSummary,
  implementationGate,
  isHandsOff,
  isPausedProjectStatus,
  isTerminalProjectStatus,
  lockState,
  lockTtlMs,
  readLockComment,
  refineEntryGate,
  renderLockComment,
  resolveState,
  worktreePathFor,
} from "@foreman/core";



/** The `task` tool's per-item shape, before Foreman revises it. */
export interface TaskItemInput {
  name?: string;
  agent?: string;
  task: string;
  outputSchema?: unknown;
  schemaMode?: string;
  isolated?: boolean;
  [key: string]: unknown;
}

/** The `task` tool's whole-call shape. Also handles the flat single-spawn shape. */
export interface TaskCallInput {
  context?: string;
  tasks?: TaskItemInput[];
  agent?: string;
  task?: string;
  outputSchema?: unknown;
  schemaMode?: string;
  isolated?: boolean;
  [key: string]: unknown;
}

export interface TaskGuardDecision {
  block?: boolean;
  reason?: string;
  input?: TaskCallInput;
}

/** Everything the guard needs from the outside world, injected for testability. */
export interface TaskGuardDeps {
  linear: LinearWriter;
  github: GitHubClient;
  config: GlobalConfig;
  /** This instance's resolved registry entry (SPEC §3.11) — the repo path and merged repo settings for implement/review dispatch. */
  entry: ResolvedRepoEntry;
  now: () => Date;
  newDispatchId: (agent: string, issueId: string, now: Date) => string;
  /** Registers a dispatch id as live in this process — called for every claimed lock, inherited or minted. */
  registerLiveDispatch: (dispatchId: string) => void;
  ensureWorktree: (input: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
  }) => Promise<EnsureWorktreeResult>;
  /** Writes a diff to a temp file and returns its absolute path. */
  writeDiffFile: (issueId: string, diff: string) => Promise<string>;
  /** Dispatch IDs the extension currently believes are live, for lock-collision checks. */
  liveDispatchIds: () => readonly string[];
  /** Unregisters a dispatch id from the live registry — called for every claim `unwindPrepared` unwinds, even when the Linear rollback itself fails. */
  releaseLiveDispatch: (dispatchId: string) => void;
  /** The Context digest (SPEC §4.7) to append to the shared `context` string: product layer plus the project's brief, or the product layer alone for a null `projectId`. */
  contextDigest: (projectId: string | null) => Promise<string>;
}

const FOREMAN_PREFIX = "foreman-";
const ISSUE_MARKER_RE = /^FOREMAN-ISSUE:\s*(\S+)\s*$/gm;

/**
 * One-shot inheritance: a dispatch spawned by `foreman build`/`foreman plan`
 * carries its own dispatch id forward via `FOREMAN_DISPATCH_ID` in the
 * environment, so the loop's dispatcher and `reconcile`'s orphan check are
 * cross-referencing the same id namespace as the guard's own claim, rather
 * than two disjoint ones (SPEC §11, §17.4). Consumed exactly once: only the
 * top-level session's first claim inherits it, every subsequent claim in
 * the same process mints fresh.
 */
let inheritedDispatchId: string | null = process.env.FOREMAN_DISPATCH_ID ?? null;

/** The last `FOREMAN-ISSUE` (or similarly shaped) marker line: the guard appends its own after stripping the caller's, so the trailing value is the authoritative one. */
export function lastMarkerValue(re: RegExp, text: string): string | null {
  re.lastIndex = 0;
  let value: string | null = null;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) value = match[1] ?? value;
  return value;
}

/**
 * The one marker value in caller-supplied task text, refusing disagreement.
 * Untrusted issue prose is pasted into that text by every command, so
 * last-wins silently redirects the dispatch. `lastMarkerValue` stays for
 * `results/sink.ts`, whose input the guard already normalized through
 * `appendMarkers`.
 */
export function soleMarkerValue(re: RegExp, text: string, name: string): string | null {
  re.lastIndex = 0;
  const values = new Set<string>();
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match[1]) values.add(match[1]);
  }
  if (values.size > 1) {
    throw new Error(`Conflicting ${name} marker lines: ${[...values].join(", ")}; refusing to dispatch.`);
  }
  return values.size === 1 ? [...values][0]! : null;
}



type Stage = "triage" | "plan" | "roadmap" | "context" | "refine" | "implement" | "review";

export function stageFor(agent: string): Stage | null {
  if (agent === "foreman-triage") return "triage";
  if (agent === "foreman-plan") return "plan";
  if (agent === "foreman-roadmap") return "roadmap";
  if (agent === "foreman-context") return "context";
  if (agent === "foreman-refine") return "refine";
  if (agent === "foreman-implement") return "implement";
  if (agent === "foreman-review") return "review";
  return null;
}

/**
 * The pure gates read terminal *issue* state off the issue itself, but a
 * project's status is a separate fetch — so both project-status refusals
 * live here, alongside the other check that needs the network. This is the
 * path the loop's server-side filters cannot cover: an operator typing
 * `/foreman:implement ENG-1` never goes through a saved view.
 *
 * The two refusals differ in reach, mirroring the queries they backstop.
 * Terminal closes both stages out. Paused holds refinement only (SPEC
 * §4.2b) — implement and review keep running, so a pause never strands
 * work already committed to Todo.
 */
async function evaluateGate(stage: Stage, issue: Issue, deps: TaskGuardDeps, viewerId: string): Promise<GateResult | null> {
  if (stage !== "refine" && stage !== "implement") return null;
  const projectStatus = issue.project ? await deps.linear.projectStatus(issue.project.id) : null;
  const result = stage === "refine" ? refineEntryGate(issue) : implementationGate(issue, viewerId);
  if (isTerminalProjectStatus(projectStatus)) {
    return {
      ok: false,
      failures: [
        ...result.failures,
        {
          code: "terminal-project",
          message: `Project "${issue.project?.name}" is ${projectStatus?.name} (${projectStatus?.type}); its work is closed out.`,
        },
      ],
    };
  }
  if (stage === "refine" && isPausedProjectStatus(projectStatus)) {
    return {
      ok: false,
      failures: [
        ...result.failures,
        {
          code: "paused-project",
          message:
            `Project "${issue.project?.name}" is ${projectStatus?.name} (paused); refinement would commit new work to it. ` +
            `Un-pause the project, or implement what it already has in ${FOREMAN_STATE.ready}.`,
        },
      ],
    };
  }
  return result;
}

async function fetchIssue(linear: LinearWriter, identifier: string): Promise<Issue> {
  const issue = await linear.issue(identifier, { includeComments: true });
  if (!issue) throw new Error(`Unknown issue "${identifier}".`);
  return issue;
}

async function checkLockFree(deps: TaskGuardDeps, issue: Issue, viewerId: string | null): Promise<GateResult> {
  // The lock comment is trusted only when it was authored by this
  // credential's own Linear identity — otherwise any workspace user (or a
  // prompt-injected agent with comment access) could post a forged
  // `released: true` marker and let the guard claim on top of a live agent
  // (SPEC §11). `claimLock` already requires the viewer id to claim, so
  // failing closed here costs nothing extra on the happy path.
  if (viewerId === null) {
    return {
      ok: false,
      failures: [
        {
          code: "agent-running",
          message: "Could not resolve the credential's viewer id to verify lock comment authorship.",
        },
      ],
    };
  }
  const found = readLockComment(issue.comments, viewerId);
  const state = lockState(found?.data ?? null, {
    now: deps.now(),
    liveDispatchIds: deps.liveDispatchIds(),
  });
  if (state.held && !state.orphaned) {
    return {
      ok: false,
      failures: [{ code: "agent-running", message: `Lock held: ${state.reason}` }],
    };
  }
  return { ok: true, failures: [] };
}

/**
 * Claims the lock: assigns the issue to the credential's own Linear
 * identity and writes the `foreman:lock` comment in the same operation
 * (SPEC §11 — the dispatcher claims, agents never do). Assignee makes
 * ownership visible in Linear's UI without a second mutation; harmless when
 * Foreman shares the operator's own account.
 */
async function claimLock(
  linear: LinearWriter,
  issue: Issue,
  agent: string,
  dispatchId: string,
  worktree: string | null,
  now: Date,
  ttlMs: number,
): Promise<void> {
  const assigneeId = await linear.viewerId();
  await linear.updateIssue(issue.id, { assigneeId });
  const comment = renderLockComment({
    dispatchId,
    agent,
    issueId: issue.identifier,
    takenAt: now.toISOString(),
    ttlMs,
    worktree,
    released: false,
    releasedAt: null,
  });
  await linear.createComment({ issueId: issue.id, body: comment });
}

const MARKER_LINE_RE = /^FOREMAN-[A-Z-]+:.*$/gm;

/**
 * The guard's marker block is authoritative. Task text is assembled from
 * Linear issue content, so a marker-shaped line in a description would
 * otherwise be read back by `results/sink.ts` in place of the values the
 * guard actually claimed against.
 */
function appendMarkers(task: string, markers: Record<string, string | undefined>): string {
  const stripped = task.replace(MARKER_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  const lines = Object.entries(markers)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return `${stripped}\n\n${lines.join("\n")}\n`;
}

function takeDispatchId(deps: TaskGuardDeps, agent: string, subject: string, now: Date): string {
  const dispatchId = inheritedDispatchId ?? deps.newDispatchId(agent, subject, now);
  inheritedDispatchId = null;
  deps.registerLiveDispatch(dispatchId);
  return dispatchId;
}

interface PreparedCleanup {
  issue: Issue | null;
  dispatchId: string;
  agent: string;
  worktree: string | null;
  takenAt: Date;
  ttlMs: number;
  previousStateId: string | null;
}

interface PreparedItem {
  item: TaskItemInput;
  contextDigest: string | null;
  cleanup?: PreparedCleanup;
}

/**
 * Prepares one `task` item destined for a `foreman-*` agent. Mutates nothing
 * externally except the lock claim and worktree creation — everything else
 * (schema strictness, isolation removal, marker text) is returned in the
 * revised item.
 */
async function prepareItem(item: TaskItemInput, deps: TaskGuardDeps): Promise<PreparedItem> {
  const agent = item.agent;
  if (typeof agent !== "string" || !agent.startsWith(FOREMAN_PREFIX)) return { item, contextDigest: null };

  // Isolation is an allowlist, not a denylist: only the fields Foreman
  // itself needs (`name`, `agent`, `task`) survive onto a foreman-*
  // spawn. `TaskItemInput`/`TaskCallInput` accept arbitrary extra keys
  // (`tools`, `isolated`, `outputSchema`, and any future `task`-tool
  // field), so a spread-and-delete rewrite only ever blocks the keys it
  // remembers to name — a caller could otherwise smuggle e.g. `tools` to
  // grant a foreman-* agent capabilities its frontmatter never listed.
  // schemaMode is forced to "strict"; isolated/outputSchema/tools/every
  // other caller-supplied field is dropped (see the comment below on why
  // the schema always comes from frontmatter, never a caller override).
  const revised: TaskItemInput = { agent, task: item.task, schemaMode: "strict" };
  if (item.name !== undefined) revised.name = item.name;

  const stage = stageFor(agent);
  // The schema is inlined in each agent's frontmatter `output:` key
  // (`packages/core/scripts/emit-schemas.ts` emits it from the TypeBox
  // definition `core` owns, so `core` stays the single source of truth) —
  // never injected here, because per-call `outputSchema` outranks
  // frontmatter and would mask whether the inlined schema actually works.
  // `schemaMode` genuinely cannot live in frontmatter (it is a per-spawn
  // field defaulting to "permissive"), so the interceptor is the only place
  // that can force it. An agent name outside `AGENT_OUTPUT_SCHEMAS` has no
  // validated contract and must not run.
  if (stage === null || !(agent in AGENT_OUTPUT_SCHEMAS)) {
    throw new Error(`Unknown Foreman agent "${agent}".`);
  }

  // Plan, roadmap, context, and triage claim no lock — plan operates on a
  // project, roadmap on a team, context on a team document, triage
  // on a batch — but the result sink keys every capture on the
  // `FOREMAN-DISPATCH` marker it recovers from the task text
  // (`results/sink.ts`), so all four stages need one anyway. Without it
  // their `PlanResult`/`RoadmapResult`/`ContextResult`/`TriageResult` is
  // dropped on the floor: the agent yields, the extension sees a
  // structured output it cannot attribute to a dispatch, and nothing is
  // ever written to Linear.
  if (stage === "triage" || stage === "plan" || stage === "roadmap" || stage === "context") {
    let projectId: string | null = null;
    let briefPath: string | null = null;
    let batchIssueIds: string | null = null;
    if (stage === "plan") {
      projectId = soleMarkerValue(/^FOREMAN-PROJECT:\s*(\S+)\s*$/gm, item.task, "FOREMAN-PROJECT");
      if (!projectId) {
        throw new Error(`Missing "FOREMAN-PROJECT: <PROJECT-ID>" line in the task text for agent "${agent}".`);
      }
    }
    if (stage === "roadmap") {
      // Optional: a repo-relative brief/PRD/spec document to decompose.
      // Absent means the agent works from the repo's own docs.
      briefPath = soleMarkerValue(/^FOREMAN-BRIEF:\s*(\S+)\s*$/gm, item.task, "FOREMAN-BRIEF");
    }
    if (stage === "triage") {
      batchIssueIds = soleMarkerValue(/^FOREMAN-ISSUES:\s*(\S+)\s*$/gm, item.task, "FOREMAN-ISSUES");
      if (!batchIssueIds) {
        throw new Error(`Missing "FOREMAN-ISSUES: <ID>,<ID>" line in the task text for agent "${agent}".`);
      }
    }
    // "batch" matches the subject the loop's own intake dispatch mints for
    // triage (`packages/loop/src/loops/plan.ts`'s `triageRule`), so an
    // inherited and a minted id read the same way in the log.
    const dispatchId = takeDispatchId(
      deps,
      agent,
      projectId ?? (stage === "roadmap" || stage === "context" ? deps.entry.team : "batch"),
      deps.now(),
    );
    revised.task = appendMarkers(item.task, {
      "FOREMAN-DISPATCH": dispatchId,
      "FOREMAN-PROJECT": projectId ?? undefined,
      // The guard writes this itself from the resolved entry rather than
      // parsing it from the command, so a dispatch cannot name a foreign team.
      "FOREMAN-TEAM": stage === "roadmap" || stage === "context" ? deps.entry.team : undefined,
      "FOREMAN-BRIEF": briefPath ?? undefined,
      "FOREMAN-APPS": deps.entry.appNames.join(",") || undefined,
      "FOREMAN-ISSUES": batchIssueIds ?? undefined,
    });
    // Roadmap and context are the two stages that must not receive this
    // digest: roadmap's command assembles the product `Context` doc plus the
    // repo's existing projects (`team_roadmap` op) before dispatch, and
    // context's command supplies the live doc itself — appending a cached
    // copy would give that agent two versions of the doc it is rewriting.
    // Triage passes a null `projectId` (its items are unassigned by
    // definition) and so gets the product layer alone.
    return {
      item: revised,
      contextDigest: stage === "roadmap" || stage === "context" ? null : await deps.contextDigest(projectId),
      cleanup: {
        issue: null,
        dispatchId,
        agent,
        worktree: null,
        takenAt: deps.now(),
        ttlMs: lockTtlMs(deps.config),
        previousStateId: null,
      },
    };
  }

  const identifier = soleMarkerValue(ISSUE_MARKER_RE, item.task, "FOREMAN-ISSUE");
  if (!identifier) {
    throw new Error(
      `Missing "FOREMAN-ISSUE: <IDENTIFIER>" line in the task text for agent "${agent}".`,
    );
  }
  const issue = await fetchIssue(deps.linear, identifier);

  // Scope is asserted for every issue-targeted stage, refine included: a repo
  // binds one team now, so the registry entry is the whole scope check and no
  // gate re-derives it from an issue's project (SPEC §3.11).
  assertIssueInScope(deps.entry, issue);

  let viewerId: string | null;
  try {
    viewerId = await deps.linear.viewerId();
  } catch {
    viewerId = null;
  }

  if (viewerId !== null && isHandsOff(issue, viewerId)) {
    throw new Error(
      `${identifier} is assigned to ${issue.assignee?.displayName ?? issue.assignee?.name}; dispatch refused.`,
    );
  }
  const lockFree = await checkLockFree(deps, issue, viewerId);
  if (!lockFree.ok) {
    throw new Error(`${identifier}: ${gateSummary("implementation", lockFree)}`);
  }

  const gate = await evaluateGate(stage, issue, deps, viewerId ?? "");
  if (gate && !gate.ok) {
    const gateName = stage === "refine" ? "refine entry" : "implementation";
    throw new Error(`${identifier}: ${gateSummary(gateName, gate)}`);
  }

  const now = deps.now();
  const dispatchId = takeDispatchId(deps, agent, identifier, now);
  const ttlMs = lockTtlMs(deps.config);

  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseBranch: string | null = null;
  let diffPath: string | null = null;
  const previousStateId = issue.state.id;


  if (stage === "implement") {
    const repoPath = deps.entry.repoPath;
    branch = branchNameFor(deps.entry.branchPattern, issue, repoPath);
    worktreePath = worktreePathFor(deps.entry.worktreePattern, repoPath, issue);
    baseBranch = deps.entry.baseBranch;
    await deps.ensureWorktree({ repoPath, worktreePath, branch, baseBranch });
    const teamStates = await deps.linear.workflowStates(issue.team.id);
    const inProgress = resolveState("inProgress", teamStates);
    await deps.linear.updateIssue(issue.id, { stateId: inProgress.id });
  } else if (stage === "refine") {
    const teamStates = await deps.linear.workflowStates(issue.team.id);
    const refining = resolveState("refining", teamStates);
    await deps.linear.updateIssue(issue.id, { stateId: refining.id });
  } else if (stage === "review") {
    const repoPath = deps.entry.repoPath;
    baseBranch = deps.entry.baseBranch;
    branch = branchNameFor(deps.entry.branchPattern, issue, repoPath);
    const pr = await deps.github.prForBranch(repoPath, branch);
    const diff =
      deps.entry.pr.required && pr
        ? await deps.github.prDiff(repoPath, pr.number)
        : await diffRange(repoPath, baseBranch, branch);
    diffPath = await deps.writeDiffFile(identifier, diff);
  }

  await claimLock(deps.linear, issue, agent, dispatchId, worktreePath, now, ttlMs);

  revised.task = appendMarkers(item.task, {
    "FOREMAN-ISSUE": identifier,
    "FOREMAN-DISPATCH": dispatchId,
    "FOREMAN-WORKTREE": worktreePath ?? undefined,
    "FOREMAN-BRANCH": branch ?? undefined,
    "FOREMAN-DIFF": diffPath ?? undefined,
    "FOREMAN-BASE": baseBranch ?? undefined,
    "FOREMAN-APPS": deps.entry.appNames.join(",") || undefined,
    // Implement and refine both move state (Ready → In Progress, Backlog →
    // Refining); review never does, so there is nothing to restore for it
    // and the marker is omitted. Read back by the extension at
    // invalid-result handling time to avoid stranding the issue with no
    // live agent and no retry.
    "FOREMAN-PREV-STATE": stage === "implement" || stage === "refine" ? previousStateId : undefined,
  });

  return {
    item: revised,
    /*
     * Every issue-targeted stage is measured against this doc, so the guard
     * appends it rather than trusting each command to have the dispatching
     * session re-read it: `foreman-review` grades `dodSatisfied` against the
     * Definition of Done, `foreman-implement` builds to it, and
     * `foreman-refine` writes acceptance criteria that must not restate it
     * (SPEC §4.7, §4.8). An issue with no project still gets the product
     * layer — see the `contextDigest` wiring in `extension.ts`.
     */
    contextDigest: await deps.contextDigest(issue.project?.id ?? null),
    cleanup: {
      issue,
      dispatchId,
      agent,
      worktree: worktreePath,
      takenAt: now,
      ttlMs,
      previousStateId: stage === "implement" || stage === "refine" ? previousStateId : null,
    },
  };
}

/**
 * A task call is all-or-blocked: if a later item cannot be prepared, no
 * earlier lock may outlive the blocked call. Worktrees are deliberately left
 * intact for the operator; they may contain pre-existing branch state.
 */
async function unwindPrepared(cleanups: readonly PreparedCleanup[], deps: TaskGuardDeps): Promise<void> {
  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        if (cleanup.issue) {
          await deps.linear.updateIssue(cleanup.issue.id, {
            assigneeId: null,
            ...(cleanup.previousStateId ? { stateId: cleanup.previousStateId } : {}),
          });
          await deps.linear.createComment({
            issueId: cleanup.issue.id,
            body: renderLockComment({
              dispatchId: cleanup.dispatchId,
              agent: cleanup.agent,
              issueId: cleanup.issue.identifier,
              takenAt: cleanup.takenAt.toISOString(),
              ttlMs: cleanup.ttlMs,
              worktree: cleanup.worktree,
              released: true,
              releasedAt: deps.now().toISOString(),
            }),
          });
        }
      } catch {
        // Preserve the original preparation failure. `foreman reconcile`'s
        // orphan-lock pass can recover a cleanup that fails because Linear
        // itself is unavailable.
      } finally {
        // A failed Linear rollback above must still drop this id from the
        // live registry, or reconcile treats an already-unwound claim as
        // live forever (Step 5 item 4).
        deps.releaseLiveDispatch(cleanup.dispatchId);
      }
    }),
  );
}

/**
 * Entry point: revises or blocks a `task` tool call. Never throws — every
 * exception (including from a dependency) becomes `{ block: true, reason }`,
 * because `tool_call` handlers are fail-closed on a throw anyway, and a
 * caught reason is one the operator can actually read.
 */
export async function prepareTaskCall(
  input: TaskCallInput,
  deps: TaskGuardDeps,
): Promise<TaskGuardDecision> {
  const cleanups: PreparedCleanup[] = [];
  try {
    const flat = input.tasks === undefined;
    const items: TaskItemInput[] = input.tasks ?? [
      {
        agent: input.agent,
        task: input.task ?? "",
        outputSchema: input.outputSchema,
        schemaMode: input.schemaMode,
        isolated: input.isolated,
      },
    ];

    const revisedItems: TaskItemInput[] = [];
    /*
     * Keyed by digest text, not by item: a batch of N issues in one project
     * resolves to N identical digests, and `context` is shared by every item
     * in the call, so appending per item would repeat the whole product
     * `Context` doc N times. Insertion order is stable, so a batch spanning
     * two projects still reads product-first in dispatch order.
     */
    const digests = new Set<string>();
    for (const item of items) {
      const prepared = await prepareItem(item, deps);
      if (prepared.cleanup) cleanups.push(prepared.cleanup);
      if (prepared.contextDigest) digests.add(prepared.contextDigest);
      revisedItems.push(prepared.item);
    }
    const contextAppend = [...digests].map((digest) => `\n\n${digest}`).join("");

    const first = revisedItems[0];
    const revisedInput: TaskCallInput = flat
      ? {
          ...input,
          agent: first?.agent,
          task: first?.task,
          schemaMode: first?.schemaMode,
          isolated: first?.isolated,
        }
      : { ...input, tasks: revisedItems };
    delete revisedInput.outputSchema;

    if (contextAppend.length > 0) {
      revisedInput.context = `${input.context ?? ""}${contextAppend}`;
    }

    return { input: revisedInput };
  } catch (error) {
    await unwindPrepared(cleanups, deps);
    return { block: true, reason: error instanceof Error ? error.message : String(error) };
  }
}


/** Shared by the extension's config validation and the unblock/apply commands. */
export function extractIssueId(task: string): string | null {
  return lastMarkerValue(ISSUE_MARKER_RE, task);
}
