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
import type { GitHubClient, EnsureWorktreeResult } from "@foreman/core";
import {
  AGENT_LABEL,
  AGENT_OUTPUT_SCHEMAS,
  LABEL_GROUP,
  branchNameFor,
  diffRange,
  gateSummary,
  hasLabel,
  implementationGate,
  labelsInGroup,
  lockState,
  lockTtlMs,
  readLockComment,
  refinementGate,
  renderLockComment,
  repoForProject,
  resolveRepoConfig,
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
  now: () => Date;
  newDispatchId: (agent: string, issueId: string, now: Date) => string;
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
  /** The project `Context` document digest to append to the shared `context` string. */
  contextDigest: (projectId: string | null) => Promise<string>;
}

const FOREMAN_PREFIX = "foreman-";
const ISSUE_MARKER_RE = /^FOREMAN-ISSUE:\s*(\S+)\s*$/m;

type Stage = "triage" | "refine" | "implement" | "review";

function stageFor(agent: string): Stage | null {
  if (agent === "foreman-triage") return "triage";
  if (agent === "foreman-refine") return "refine";
  if (agent === "foreman-implement") return "implement";
  if (agent === "foreman-review") return "review";
  return null;
}

function evaluateGate(stage: Stage, issue: Issue): GateResult | null {
  if (stage === "refine") return refinementGate(issue);
  if (stage === "implement") return implementationGate(issue);
  return null;
}

async function fetchIssue(linear: LinearWriter, identifier: string): Promise<Issue> {
  const issue = await linear.issue(identifier, { includeComments: true });
  if (!issue) throw new Error(`Unknown issue "${identifier}".`);
  return issue;
}

function checkLockFree(deps: TaskGuardDeps, issue: Issue): GateResult {
  if (!hasLabel(issue, AGENT_LABEL.running)) return { ok: true, failures: [] };
  const found = readLockComment(issue.comments);
  const state = lockState(found?.data ?? null, {
    now: deps.now(),
    liveDispatchIds: deps.liveDispatchIds(),
  });
  if (state.held && !state.orphaned) {
    return {
      ok: false,
      failures: [{ code: "agent-running", message: `\`${AGENT_LABEL.running}\` held: ${state.reason}` }],
    };
  }
  return { ok: true, failures: [] };
}

/**
 * Claims the lock: applies `agent:running` and writes the `foreman:lock`
 * comment in the same operation (SPEC §11 — the dispatcher claims, agents
 * never do).
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
  const runningLabel = await linear.ensureLabel(AGENT_LABEL.running, issue.team.id);
  await linear.updateIssue(issue.id, { addedLabelIds: [runningLabel.id] });
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

function appendMarkers(task: string, markers: Record<string, string | undefined>): string {
  const lines = Object.entries(markers)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return `${task}\n\n${lines.join("\n")}\n`;
}

function projectIdOf(issue: Issue): string {
  if (!issue.project) {
    throw new Error(`${issue.identifier} has no project; cannot resolve its repo.`);
  }
  return issue.project.id;
}

interface PreparedItem {
  item: TaskItemInput;
  contextDigest: string | null;
}

/**
 * Prepares one `task` item destined for a `foreman-*` agent. Mutates nothing
 * externally except the lock claim and worktree creation — everything else
 * (schema strictness, isolation removal, marker text) is returned in the
 * revised item.
 */
async function prepareItem(item: TaskItemInput, deps: TaskGuardDeps): Promise<PreparedItem> {
  const agent = item.agent;
  if (!agent || !agent.startsWith(FOREMAN_PREFIX)) return { item, contextDigest: null };

  const revised: TaskItemInput = { ...item, schemaMode: "strict" };
  delete revised.isolated;

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

  if (stage === "triage") {
    const digest = await deps.contextDigest(null);
    return { item: revised, contextDigest: digest };
  }

  const match = ISSUE_MARKER_RE.exec(item.task);
  const identifier = match?.[1];
  if (!identifier) {
    throw new Error(
      `Missing "FOREMAN-ISSUE: <IDENTIFIER>" line in the task text for agent "${agent}".`,
    );
  }
  const issue = await fetchIssue(deps.linear, identifier);

  if (hasLabel(issue, AGENT_LABEL.handsOff)) {
    throw new Error(`${identifier} carries \`${AGENT_LABEL.handsOff}\`; dispatch refused.`);
  }
  const blockedLabels = labelsInGroup(issue, LABEL_GROUP.blocked);
  if (blockedLabels.length > 0) {
    throw new Error(`${identifier} carries \`${blockedLabels.join("`, `")}\`; dispatch refused.`);
  }
  const lockFree = checkLockFree(deps, issue);
  if (!lockFree.ok) {
    throw new Error(`${identifier}: ${gateSummary("implementation", lockFree)}`);
  }

  const gate = evaluateGate(stage, issue);
  if (gate && !gate.ok) {
    const gateName = stage === "refine" ? "refinement" : "implementation";
    throw new Error(`${identifier}: ${gateSummary(gateName, gate)}`);
  }

  const now = deps.now();
  const dispatchId = deps.newDispatchId(agent, identifier, now);
  const ttlMs = lockTtlMs(deps.config);

  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseBranch: string | null = null;
  let diffPath: string | null = null;

  if (stage === "implement") {
    const repoPath = repoForProject(deps.config, projectIdOf(issue));
    const repoSettings = resolveRepoConfig(deps.config, repoPath);
    branch = branchNameFor(repoSettings.branchPattern, issue);
    worktreePath = worktreePathFor(repoSettings.worktreePattern, repoPath, issue);
    baseBranch = repoSettings.baseBranch;
    await deps.ensureWorktree({ repoPath, worktreePath, branch, baseBranch });
    const teamStates = await deps.linear.workflowStates(issue.team.id);
    const inProgress = resolveState("inProgress", teamStates);
    await deps.linear.updateIssue(issue.id, { stateId: inProgress.id });
  } else if (stage === "review") {
    const repoPath = repoForProject(deps.config, projectIdOf(issue));
    const repoSettings = resolveRepoConfig(deps.config, repoPath);
    baseBranch = repoSettings.baseBranch;
    branch = issue.branchName;
    const pr = await deps.github.prForBranch(repoPath, branch);
    const diff =
      repoSettings.pr.required && pr
        ? await deps.github.prDiff(repoPath, pr.number)
        : await diffRange(repoPath, baseBranch, branch);
    diffPath = await deps.writeDiffFile(identifier, diff);
  }

  await claimLock(deps.linear, issue, agent, dispatchId, worktreePath, now, ttlMs);

  revised.task = appendMarkers(item.task, {
    "FOREMAN-DISPATCH": dispatchId,
    "FOREMAN-WORKTREE": worktreePath ?? undefined,
    "FOREMAN-BRANCH": branch ?? undefined,
    "FOREMAN-DIFF": diffPath ?? undefined,
    "FOREMAN-BASE": baseBranch ?? undefined,
  });

  return { item: revised, contextDigest: null };
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
    let contextAppend = "";
    for (const item of items) {
      const prepared = await prepareItem(item, deps);
      if (prepared.contextDigest) contextAppend += `\n\n${prepared.contextDigest}`;
      revisedItems.push(prepared.item);
    }

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

    if (contextAppend.length > 0) {
      revisedInput.context = `${input.context ?? ""}${contextAppend}`;
    }

    return { input: revisedInput };
  } catch (error) {
    return { block: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Shared by the extension's config validation and the unblock/apply commands. */
export function extractIssueId(task: string): string | null {
  return ISSUE_MARKER_RE.exec(task)?.[1] ?? null;
}
