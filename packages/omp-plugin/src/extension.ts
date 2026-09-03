/**
 * Foreman's omp extension factory (SPEC §3.5). Wires the two tools, the
 * three commands, and every event the extension owns: `session_start`
 * (config validation, skill guard), `tool_call` (the task guard),
 * `tool_result` and the three `task:subagent:*` events (result capture).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallDecision, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { BlockRecord, LinearWriter, ResolvedRepoEntry } from "@foreman/core";
import {
  AGENT_OUTPUT_SCHEMAS,
  all,
  ConfigError,
  ensureWorktree,
  isBudgetTruncation,
  issueIdFromDispatchId,
  lockState,
  newDispatchId,
  parseAgentOutput,
  readLockComment,
  resolveState,
  RUNNING_FILTER,
  type ForemanAgentName,
} from "@foreman/core";
import { checkSkillAutoload, formatSkillGuardProblem } from "./enforce/skill-guard.ts";
import { prepareTaskCall, type TaskCallInput, type TaskGuardDeps } from "./enforce/task-guard.ts";
import { runMerge } from "./commands/merge.ts";
import { runUnblock } from "./commands/unblock.ts";
import { renderStatus } from "./commands/status.ts";
import { COMMAND_NAMES } from "./commands/names.ts";
import { registerGitHubPrTool } from "./tools/github-pr.ts";
import { registerLinearReadTool } from "./tools/linear-read.ts";
import { applyOutcome, type ApplyDeps, type AgentOutcome, type AppliedFacts } from "./results/apply.ts";
import { extractFromToolResult, sink, type AppliedTracker } from "./results/sink.ts";
import {
  getConfig,
  getEntry,
  getGitHub,
  getLinear,
  getContextDigest,
  initRuntime,
  isRepoRegistered,
  liveDispatchIds,
  registerLiveDispatch,
  releaseLiveDispatch,
  resetRuntime,
} from "./runtime.ts";

const appliedDispatchIds = new Set<string>();
const inFlightCaptures = new Map<string, Promise<void>>();
const reviewDiffDirs = new Map<string, string>();

/** Test-only seam: clears the in-process applied-dispatch dedup set between test cases. */
export function __resetAppliedDispatchIdsForTest(): void {
  appliedDispatchIds.clear();
}

/** Test-only seam: clears in-flight capture mutexes between test cases. */
export function __resetInFlightCapturesForTest(): void {
  inFlightCaptures.clear();
}

function toApplyDeps(): ApplyDeps {
  return { linear: getLinear(), github: getGitHub(), now: () => new Date(), entry: getEntry(), operatorUserId: getConfig().linear.operatorUserId };
}

function toGuardDeps(): TaskGuardDeps {
  return {
    linear: getLinear(),
    github: getGitHub(),
    config: getConfig(),
    entry: getEntry(),
    now: () => new Date(),
    newDispatchId: (agent, issueId, now) => newDispatchId(agent, issueId, now),
    registerLiveDispatch,
    ensureWorktree: (input) => ensureWorktree(input),
    writeDiffFile: async (issueId, diff) => {
      const prior = reviewDiffDirs.get(issueId);
      if (prior) rmSync(prior, { recursive: true, force: true });
      const dir = mkdtempSync(join(tmpdir(), `foreman-review-${issueId}-`));
      reviewDiffDirs.set(issueId, dir);
      const path = join(dir, "diff.patch");
      writeFileSync(path, diff);
      return path;
    },
    liveDispatchIds,
    releaseLiveDispatch,
    contextDigest: async (projectId) => (projectId ? getContextDigest(projectId) : ""),
  };
}

/**
 * Plan, roadmap, and triage dispatch ids carry a project id, an initiative
 * id, or the literal "batch" where the issue-stage ids carry an identifier —
 * `issueIdFromDispatchId`'s regex extraction cannot tell the difference, so
 * every caller that would otherwise hand its result to a Linear issue-scoped
 * lookup must check this first.
 */
export function isProjectScopedAgent(agent: string): boolean {
  return agent === "foreman-plan" || agent === "foreman-roadmap" || agent === "foreman-triage";
}

/** In-memory only (no durable Linear marker): tracks dispatch ids this process has already applied. */
function markerAppliedTracker(): AppliedTracker {
  return {
    wasApplied: async (dispatchId: string) => appliedDispatchIds.has(dispatchId),
  };
}

/** Wraps a `BlockRecord` in the `AgentOutcome` union `applyOutcome` consumes, targeting the issue the dispatch's lock was taken against. */
export function blockedOutcome(agentName: ForemanAgentName, block: BlockRecord, target: string | null): AgentOutcome {
  return { kind: "blocked", agent: agentName, block, issueId: target ?? "" };
}


function isForemanAgentName(agent: string): agent is ForemanAgentName {
  return agent in AGENT_OUTPUT_SCHEMAS;
}

/**
 * Resolves the Linear team id an entry's bound `team` key actually refers
 * to. `team` is required and non-nullable on every resolved entry.
 */
async function resolveEntryTeamId(linear: LinearWriter, entry: ResolvedRepoEntry): Promise<string | null> {
  const teams = await linear.teams();
  return teams.find((team) => team.key === entry.team)?.id ?? null;
}

/**
 * SPEC §11, §17.6/§17.7: the `session_start` sibling of `reconcile`'s
 * `stale-running` invariant — a manual `/foreman:implement` (or any
 * plugin-only, loop-less deployment) that dies mid-run leaves an orphaned
 * `foreman:running` lock nothing else will ever clear. Runs once per
 * session start; no timer.
 */
async function repairOrphanedLocks(linear: LinearWriter, now: Date): Promise<number> {
  const issues = await linear.issues({
    filter: RUNNING_FILTER,
    includeComments: true,
  });
  let repaired = 0;
  for (const issue of issues) {
    const record = readLockComment(issue.comments ?? [])?.data ?? null;
    const orphaned = lockState(record, { now, liveDispatchIds: liveDispatchIds() }).orphaned;
    if (!orphaned && record !== null) continue;

    await linear.updateIssue(issue.id, { assigneeId: null });
    if (issue.state.type === "started") {
      const states = await linear.workflowStates(issue.team.id);
      await linear.updateIssue(issue.id, { stateId: resolveState("ready", states).id });
    }
    const summary = record
      ? `Foreman: released orphaned lock ${record.dispatchId} (taken ${record.takenAt}).`
      : "Foreman: released an orphaned lock with no matching lock comment.";
    await linear.createComment({ issueId: issue.id, body: summary });
    repaired += 1;
  }
  return repaired;
}

/**
 * Applies an `AgentOutcome` after verifying it targets the issue this
 * dispatch's lock was actually taken against (Step 4): a result naming a
 * different issue than the dispatch's `FOREMAN-ISSUE` line is rejected
 * without mutating either issue, comments on the locked issue, releases its
 * lock, and notifies the operator, instead of silently applying an
 * agent-supplied identifier. Triage and plan are exempt — they operate on a
 * batch or a project respectively, not the single issue a dispatch locks.
 */
export async function applyBoundResult(
  deps: ApplyDeps,
  agent: string,
  outcome: AgentOutcome,
  target: string | null,
  previousStateId: string | null,
  notify: (message: string, level: "warn" | "error") => void,
): Promise<AppliedFacts> {
  if (
    outcome.kind === "result" &&
    target &&
    agent !== "foreman-plan" &&
    agent !== "foreman-roadmap" &&
    agent !== "foreman-triage" &&
    "issueId" in outcome.result &&
    outcome.result.issueId !== target
  ) {
    const reported = outcome.result.issueId;
    await deps.linear.createComment({
      issueId: target,
      body: `Foreman rejected this dispatch result: it reported issue ${reported}, but this dispatch locked ${target}.`,
    });
    const lockedIssue = await deps.linear.issue(target);
    if (lockedIssue) {
      const mutation: { stateId?: string } = {};
      // The guard already moved this issue to In Progress or Refining;
      // restore the dispatch's recorded pre-claim state, mirroring the
      // invalid-result branch below, so it does not strand with no live
      // agent and no retry.
      if (previousStateId && lockedIssue.state.id !== previousStateId) mutation.stateId = previousStateId;
      if (Object.keys(mutation).length > 0) await deps.linear.updateIssue(lockedIssue.id, mutation);
    }
    notify(`Foreman rejected ${agent}'s result: it reported issue ${reported}, but this dispatch locked ${target}.`, "error");
    return {
      subject: target,
      summary: `reported issue ${reported}, but this dispatch locked ${target}`,
      created: [],
      movedTo: null,
    };
  }
  return applyOutcome(deps, outcome, notify);
}


/**
 * Applies one captured dispatch result. Exported (with an injectable `deps`
 * and `tracker`, defaulting to the module's live `toApplyDeps()` and
 * `markerAppliedTracker()`) so tests can exercise the invalid-result state
 * restore and the `appliedDispatchIds` failure-recovery behavior without a
 * full runtime.
 */
export async function handleCaptured(
  dispatchId: string,
  agent: string,
  data: unknown,
  aborted: boolean,
  lockedIssueId: string | null,
  previousStateId: string | null,
  notify: (message: string, level: "warn" | "error") => void,
  deps: ApplyDeps = toApplyDeps(),
  tracker: AppliedTracker = markerAppliedTracker(),
): Promise<void> {
  if (!isForemanAgentName(agent)) return;
  if (appliedDispatchIds.has(dispatchId)) return;

  const existing = inFlightCaptures.get(dispatchId);
  if (existing) {
    await existing;
    return;
  }

  const work = (async () => {
    if (appliedDispatchIds.has(dispatchId)) return;
    // Plan, roadmap, and triage dispatch ids carry a project id, an
    // initiative id, or the literal "batch" where the issue-stage ids carry
    // an identifier, so decoding one back into a "locked issue" would hand
    // every downstream branch a target that is not an issue at all. None of
    // those stages lock anything: no target.
    const target =
      lockedIssueId ??
      (isProjectScopedAgent(agent) ? null : issueIdFromDispatchId(dispatchId));
    try {
      const parsed = parseAgentOutput(agent, data);
      if (parsed.kind === "invalid") {
        const truncated = isBudgetTruncation({ aborted, problems: parsed.problems });
        if (truncated) {
          if (target) {
            await applyOutcome(deps, blockedOutcome(agent, {
              blocked: true, type: "budget", whatIWasDoing: "Producing a validated agent result",
              whatINeed: "Increase the dispatch budget or narrow the task before retrying.",
              options: null, recommendation: null, stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "Output was truncated before validation." },
              costOfWrongGuess: "Applying an incomplete result could corrupt the issue state.", blockedByIssues: [target],
            }, target));
          } else {
            notify(`Foreman dropped a budget-truncated ${agent} result: no issue was locked for this dispatch, so there is nothing to mark blocked.`, "error");
          }
        } else {
          const issue = target ? await deps.linear.issue(target, { includeComments: true }) : null;
          if (issue) {
            await deps.linear.createComment({ issueId: issue.id, body: `Foreman could not validate this dispatch result:\n${parsed.problems.map((problem) => `- ${problem}`).join("\n")}` });
            const mutation: { stateId?: string } = {};
            // The guard already moved this issue to In Progress or Refining;
            // restore the dispatch's recorded pre-claim state so the issue
            // does not strand there with no live agent and no retry — a
            // no-op for review, which never moves state.
            if (previousStateId && issue.state.id !== previousStateId) mutation.stateId = previousStateId;
            if (Object.keys(mutation).length > 0) await deps.linear.updateIssue(issue.id, mutation);
          }
          notify(`Foreman rejected ${agent}'s invalid result: ${parsed.problems.join("; ")}`, "error");
        }
        appliedDispatchIds.add(dispatchId);
        return;
      }
      if (parsed.kind === "blocked" && target === null) {
        notify(`Foreman received a block from ${agent} with no locked issue: ${parsed.block.whatINeed}`, "warn");
        appliedDispatchIds.add(dispatchId);
        return;
      }
      await sink({ dispatchId, agent, data, aborted, issueId: lockedIssueId, previousStateId }, tracker, async (captured) => {
        const outcome: AgentOutcome = parsed.kind === "blocked" ? blockedOutcome(agent, parsed.block, target) : { kind: "result", agent, result: parsed.result } as AgentOutcome;
        await applyBoundResult(deps, agent, outcome, target, previousStateId, notify);
        void captured;
      });
      // Recorded only after the sink callback (`applyOutcome`) resolves: if
      // it throws, the id must not stay poisoned in the set, or a
      // redelivery of the same result through the other subscribed channel
      // is dropped for good. `markerAppliedTracker` is in-memory only, so
      // this is the sole dedup for the lifetime of the process.
      appliedDispatchIds.add(dispatchId);
    } catch (error) {
      appliedDispatchIds.delete(dispatchId);
      throw error;
    } finally {
      releaseLiveDispatch(dispatchId);
      const dir = target ? reviewDiffDirs.get(target) : undefined;
      if (dir && target) { rmSync(dir, { recursive: true, force: true }); reviewDiffDirs.delete(target); }
    }
  })();

  inFlightCaptures.set(dispatchId, work);
  try {
    await work;
  } finally {
    if (inFlightCaptures.get(dispatchId) === work) {
      inFlightCaptures.delete(dispatchId);
    }
  }
}

/**
 * The plugin directory, derived from this module's own location rather than
 * received as an argument: omp calls the factory with `(pi)` alone, so an
 * `options.pluginRoot` parameter is `undefined` at load time and takes the
 * whole extension down with it. This module is `src/extension.ts`, one level
 * below the plugin root, which is what the two `dirname` calls strip.
 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Foreman's extension factory. omp calls this once per session with the loaded `ExtensionAPI`. */
export default function createForemanExtension(pi: ExtensionAPI) {
  pi.setLabel("Foreman");

  registerLinearReadTool(pi);
  registerGitHubPrTool(pi);

  const commandName = (key: keyof typeof COMMAND_NAMES): string => COMMAND_NAMES[key];
  const runCommand = async (
    customType: string,
    work: (linear: LinearWriter) => Promise<string>,
  ): Promise<void> => {
    try {
      if (!isRepoRegistered()) {
        await pi.sendMessage(
          {
            customType,
            content: "This repository is not registered with Foreman. Run `foreman init` here first.",
            display: true,
            attribution: "assistant",
          },
          { triggerTurn: false },
        );
        return;
      }
      const content = await work(getLinear());
      await pi.sendMessage({ customType, content, display: true, attribution: "assistant" }, { triggerTurn: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const content = message.startsWith("No Linear API key resolved")
        ? "No Linear API key resolved for this repo. Foreman's Linear tools and commands will fail until one is configured."
        : `Foreman command failed: ${message}`;
      await pi.sendMessage({ customType, content, display: true, attribution: "assistant" }, { triggerTurn: false });
    }
  };


  pi.registerCommand(commandName("status"), {
    description: "Foreman operator console: blocked queue and in-flight locks.",
    handler: async () =>
      runCommand("foreman.status", async (linear) => renderStatus(linear)),
  });

  pi.registerCommand(commandName("merge"), {
    description: "Merge one issue's PR (or branch) once the review gate passes. Operator-invoked only.",
    handler: async (args: string) =>
      runCommand("foreman.merge", async (linear) => {
        const issueId = args.trim();
        return (await runMerge(linear, getGitHub(), issueId)).message;
      }),
  });

  pi.registerCommand(commandName("unblock"), {
    description: "Record the operator's reply to a blocked issue and clear its foreman:blocked label.",
    handler: async (args: string) =>
      runCommand("foreman.unblock", async (linear) => {
        const [issueId, ...replyParts] = args.trim().split(/\s+/);
        const reply = replyParts.join(" ");
        if (!issueId) return "Usage: /foreman:unblock <ISSUE-ID> <reply>";
        return (await runUnblock(linear, issueId, reply, getEntry())).message;
      }),
  });


  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    resetRuntime();
    const init = initRuntime();
    if (init.missingApiKey) {
      ctx.ui.notify(
        "No Linear API key resolved for this repo. Foreman's Linear tools and commands will fail until one is configured.",
        "warn",
      );
    }
    for (const warning of init.warnings) ctx.ui.notify(warning, "warn");

    try {
      getConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        ctx.ui.notify(`Invalid Foreman config: ${error.message}`, "error");
      }
      return;
    }

    if (existsSync(join(PLUGIN_ROOT, "agents"))) {
      const problems = checkSkillAutoload({ pluginRoot: PLUGIN_ROOT, cwd: ctx.cwd });
      for (const problem of problems) ctx.ui.notify(formatSkillGuardProblem(problem), "error");
    }

    if (isRepoRegistered()) {
      try {
        const linear = getLinear();
        const repaired = await repairOrphanedLocks(linear, new Date());
        if (repaired > 0) {
          ctx.ui.notify(`Foreman: repaired ${repaired} orphaned lock(s).`, "warn");
        }
      } catch (error) {
        ctx.ui.notify(
          `Foreman: session-start repair pass failed: ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
      }
    }
  });


  pi.on("tool_call", async (event: ToolCallEvent, _ctx: ExtensionContext): Promise<ToolCallDecision | void> => {
    if (event.toolName !== "task") return;
    // Most repos never register with Foreman at all — that is normal, not an
    // error — so an unregistered cwd must not intercept `task` calls at all;
    // `toGuardDeps` calls `getEntry()`, which throws on an unregistered cwd.
    if (!isRepoRegistered()) return;
    const guardDeps = toGuardDeps();
    const decision = await prepareTaskCall(event.input as TaskCallInput, guardDeps);
    if (decision.block) return { block: true, reason: decision.reason };
    return { input: decision.input };
  });

  const reportFailure = (ctx: ExtensionContext) => (error: unknown) => {
    const message = `Foreman could not apply an agent result: ${String(error)}`;
    pi.logger.error(message);
    ctx.ui.notify(message, "error");
  };
  // Only `tool_result` carries structured output. The three
  // `task:subagent:*` channels report status alone — no task text and no
  // `structuredOutput` — so listening on them can never capture a result
  // (`results/sink.ts`, docs/VERIFIED.md). Every Foreman agent therefore
  // declares `blocking: true`, which keeps its `SingleResult` in the `task`
  // tool result rather than in a background job's `async-result` delivery.
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== "task") return;
    for (const item of extractFromToolResult(event)) {
      try { await handleCaptured(item.dispatchId, item.agent, item.data, item.aborted, item.issueId, item.previousStateId, ctx.ui.notify); }
      catch (error) { reportFailure(ctx)(error); }
    }
  });

  return {};
}
