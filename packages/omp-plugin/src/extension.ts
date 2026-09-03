/**
 * Foreman's omp extension factory (SPEC §3.5). Wires the two tools, the four
 * commands, and every event the extension owns: `session_start` (config
 * validation, skill guard, reaper sweep + timer), `tool_call` (the task
 * guard), `tool_result` and the three `task:subagent:*` events (result
 * capture), and `session_shutdown` (clear timers).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallDecision, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { AgentReport, BlockRecord, LinearWriter } from "@foreman/core";
import {
  AGENT_OUTPUT_SCHEMAS,
  ConfigError,
  findMarkers,
  ensureMaintenanceProjects,
  ensureWorktree,
  isBudgetTruncation,
  issueIdFromDispatchId,
  MARKER_KIND,
  newDispatchId,
  parseAgentOutput,
  resolveTeamKey,
  sendLoopReport,
  YOLO_CONFIRMER,
  type ForemanAgentName,
} from "@foreman/core";
import { checkSkillAutoload, formatSkillGuardProblem } from "./enforce/skill-guard.ts";
import { prepareTaskCall, type TaskCallInput, type TaskGuardDeps } from "./enforce/task-guard.ts";
import { sweep } from "./lock/reaper.ts";
import { runApplyCommand } from "./commands/apply.ts";
import { runMerge } from "./commands/merge.ts";
import { runUnblock } from "./commands/unblock.ts";
import { renderStatus } from "./commands/status.ts";
import { COMMAND_NAMES } from "./commands/names.ts";
import { registerGitHubPrTool } from "./tools/github-pr.ts";
import { registerLinearReadTool } from "./tools/linear-read.ts";
import { applyOutcome, markApplied, type ApplyDeps, type AgentOutcome, type AppliedFacts } from "./results/apply.ts";
import { extractFromToolResult, sink, type AppliedTracker } from "./results/sink.ts";
import {
  getConfig,
  getEntry,
  getGitHub,
  getLinear,
  getContextDigest,
  getLoopSocket,
  initRuntime,
  isRepoRegistered,
  liveDispatchIds,
  registerLiveDispatch,
  releaseLiveDispatch,
  resetRuntime,
} from "./runtime.ts";

const REAPER_INTERVAL_MS = 5 * 60 * 1000;
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
  return { linear: getLinear(), github: getGitHub(), now: () => new Date(), entry: getEntry() };
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

function markerAppliedTracker(): AppliedTracker {
  return {
    wasApplied: async (dispatchId: string, agent: string) => {
      // A project-scoped dispatch id's "subject" is never an issue id —
      // querying Linear's issue-by-id endpoint with one throws
      // `LinearApiError: Entity not found: Issue` before `apply()` ever
      // runs, discarding the whole result with nothing created. There is no
      // durable dedup for these agents (SPEC: duplicate risk is bounded
      // upstream by routing/operator-only dispatch), so "not applied yet" is
      // the only safe answer.
      if (isProjectScopedAgent(agent)) return false;
      const issueId = issueIdFromDispatchId(dispatchId);
      if (!issueId) return false;
      const issue = await getLinear().issue(issueId, { includeComments: true });
      if (!issue) return false;
      // Fail closed on unverifiable authorship: a forged `dispatch-applied`
      // marker from another user must never mask a genuine unapplied
      // dispatch, so an unresolved viewer id means "not applied yet"
      // (worst case: a redundant apply attempt, never a bypassed dedup).
      let viewerId: string | null;
      try {
        viewerId = await getLinear().viewerId();
      } catch {
        viewerId = null;
      }
      if (viewerId === null) return false;
      return findMarkers<{ dispatchId?: unknown }>(MARKER_KIND.dispatchApplied, issue.comments, {
        authoredBy: viewerId,
      }).some((marker) => marker.data.dispatchId === dispatchId);
    },
  };
}

/** Wraps a `BlockRecord` in the `AgentOutcome` union `applyOutcome` consumes, targeting the issue the dispatch's lock was taken against. */
export function blockedOutcome(agentName: ForemanAgentName, block: BlockRecord, target: string | null): AgentOutcome {
  return { kind: "blocked", agent: agentName, block, issueId: target ?? "" };
}


/**
 * The marker-tracking issue for an outcome. Triage yields one proposal per
 * item across many issues rather than one issue per dispatch, so its
 * applied-marker anchor is the batch's first item — the one dispatch id
 * still resolves to at least one issue `wasApplied` can check.
 */
function issueIdOf(outcome: AgentOutcome): string {
  if (outcome.kind === "blocked") return outcome.issueId;
  if (outcome.agent === "foreman-triage") return outcome.result.items[0]?.issueId ?? "";
  // Plan and roadmap results create Linear entities rather than referencing
  // one — there is no pre-existing anchor for the applied-marker dedup, so it
  // is skipped (`handleCaptured` no-ops `markApplied` on an empty string).
  // Duplicate application risk is bounded upstream: routing only ever
  // dispatches `foreman-plan` at a bare (zero-issue) project, and a project
  // stops being a candidate the moment its first issue lands; `foreman-roadmap`
  // is operator-invoked and never dispatched by the loop at all.
  if (outcome.agent === "foreman-plan" || outcome.agent === "foreman-roadmap") return "";
  return outcome.result.issueId;
}

function isForemanAgentName(agent: string): agent is ForemanAgentName {
  return agent in AGENT_OUTPUT_SCHEMAS;
}

/**
 * Ships an `AgentReport` to the loop that dispatched this session, when one
 * did. Awaited rather than fired and forgotten: `omp -p` exits the moment the
 * turn ends, and an unawaited socket write would die with the process.
 * `sendLoopReport` swallows every transport failure, so this never throws.
 */
async function defaultReportSink(report: AgentReport): Promise<void> {
  const socketPath = getLoopSocket();
  if (!socketPath) return;
  await sendLoopReport(socketPath, report);
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
  dispatchId: string,
  previousStateId: string | null,
  notify: (message: string, level: "warn" | "error") => void,
): Promise<AgentReport> {
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
      const running = lockedIssue.labels.find((label) => label.name === "agent:running");
      const mutation: { removedLabelIds?: string[]; stateId?: string } = {};
      if (running) mutation.removedLabelIds = [running.id];
      // The guard already moved this issue Todo → In Progress (implement
      // only); removing `agent:running` alone would strand it there with no
      // live agent and no retry, since `routeImplement` only selects Todo.
      // Restore the dispatch's recorded pre-claim state in the same
      // mutation, mirroring the invalid-result branch below.
      if (previousStateId && lockedIssue.state.id !== previousStateId) mutation.stateId = previousStateId;
      if (Object.keys(mutation).length > 0) await deps.linear.updateIssue(lockedIssue.id, mutation);
    }
    notify(`Foreman rejected ${agent}'s result: it reported issue ${reported}, but this dispatch locked ${target}.`, "error");
    return {
      dispatchId,
      agent,
      status: "rejected",
      subject: target,
      summary: `reported issue ${reported}, but this dispatch locked ${target}`,
      created: [],
      movedTo: null,
    };
  }
  const facts = await applyOutcome(deps, outcome, notify);
  const issueId = issueIdOf(outcome);
  if (issueId) await markApplied(deps, issueId, dispatchId);
  return { dispatchId, agent, status: outcome.kind === "blocked" ? "blocked" : "applied", ...facts };
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
  sendReport: (report: AgentReport) => Promise<void> = defaultReportSink,
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
            const facts = await applyOutcome(deps, blockedOutcome(agent, {
              blocked: true, type: "budget", whatIWasDoing: "Producing a validated agent result",
              whatINeed: "Increase the dispatch budget or narrow the task before retrying.",
              options: null, recommendation: null, stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "Output was truncated before validation." },
              costOfWrongGuess: "Applying an incomplete result could corrupt the issue state.", blockedByIssues: [target],
            }, target));
            await sendReport({ dispatchId, agent, status: "blocked", ...facts });
          } else {
            notify(`Foreman dropped a budget-truncated ${agent} result: no issue was locked for this dispatch, so there is nothing to mark blocked.`, "error");
            await sendReport({ dispatchId, agent, status: "rejected", subject: null,
              summary: "budget-truncated result with no locked issue", created: [], movedTo: null });
          }
        } else {
          const issue = target ? await deps.linear.issue(target, { includeComments: true }) : null;
          if (issue) {
            await deps.linear.createComment({ issueId: issue.id, body: `Foreman could not validate this dispatch result:\n${parsed.problems.map((problem) => `- ${problem}`).join("\n")}` });
            const running = issue.labels.find((label) => label.name === "agent:running");
            const mutation: { removedLabelIds?: string[]; stateId?: string } = {};
            if (running) mutation.removedLabelIds = [running.id];
            // The guard already moved this issue Todo → In Progress (implement
            // only); removing `agent:running` alone would strand it there with
            // no live agent and no retry, since `routeImplement` only selects
            // Todo. Restore the dispatch's recorded pre-claim state — a no-op
            // for refine/review, which never move state (Step 5 item 1).
            if (previousStateId && issue.state.id !== previousStateId) mutation.stateId = previousStateId;
            if (Object.keys(mutation).length > 0) await deps.linear.updateIssue(issue.id, mutation);
          }
          notify(`Foreman rejected ${agent}'s invalid result: ${parsed.problems.join("; ")}`, "error");
          await sendReport({ dispatchId, agent, status: "rejected", subject: target,
            summary: `invalid result: ${parsed.problems.join("; ")}`, created: [], movedTo: null });
        }
        appliedDispatchIds.add(dispatchId);
        return;
      }
      if (parsed.kind === "blocked" && target === null) {
        notify(`Foreman received a block from ${agent} with no locked issue: ${parsed.block.whatINeed}`, "warn");
        await sendReport({ dispatchId, agent, status: "rejected", subject: null,
          summary: `block with no locked issue: ${parsed.block.whatINeed}`, created: [], movedTo: null });
        appliedDispatchIds.add(dispatchId);
        return;
      }
      const applied: { report: AgentReport | null } = { report: null };
      await sink({ dispatchId, agent, data, aborted, issueId: lockedIssueId, previousStateId }, tracker, async (captured) => {
        const outcome: AgentOutcome = parsed.kind === "blocked" ? blockedOutcome(agent, parsed.block, target) : { kind: "result", agent, result: parsed.result } as AgentOutcome;
        applied.report = await applyBoundResult(deps, agent, outcome, target, captured.dispatchId, previousStateId, notify);
      });
      const report = applied.report;
      if (report) await sendReport(report);
      // Recorded only after the sink callback (applyOutcome + markApplied)
      // resolves: if either throws, the id must not stay poisoned in the set,
      // or a redelivery of the same result through the other subscribed
      // channel is dropped with no durable marker ever written (Step 5 item
      // 2). The Linear-backed `markerAppliedTracker` remains the durable dedup.
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
    description: "Foreman operator console: blocked queue, locks, proposals, agents, loop state.",
    handler: async () =>
      runCommand("foreman.status", async (linear) => renderStatus(linear)),
  });

  pi.registerCommand(commandName("apply"), {
    description: "Apply approved triage proposals, or approve/reject one by issue id.",
    handler: async (args: string) =>
      runCommand("foreman.apply", async (linear) => {
        const argv = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
        const result = await runApplyCommand(linear, argv, getEntry());
        const lines = [result.message];
        if (result.plan) {
          for (const entry of result.plan) lines.push(`- ${entry.issueId}: ${entry.item.type} → ${entry.item.destination}`);
        }
        return lines.join("\n");
      }),
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
    description: "Record the operator's reply to a blocked issue and clear its blocked:* label.",
    handler: async (args: string) =>
      runCommand("foreman.unblock", async (linear) => {
        const [issueId, ...replyParts] = args.trim().split(/\s+/);
        const reply = replyParts.join(" ");
        if (!issueId) return "Usage: /foreman:unblock <ISSUE-ID> <reply>";
        return (await runUnblock(linear, issueId, reply, getEntry())).message;
      }),
  });

  let reaperTimer: unknown = null;

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

    // Ensure pass (SPEC §3.11): every initiative bound to this instance must
    // exist and have its standing Maintenance project. Runs alongside the
    // config/scope validation above, not inside `initRuntime` — that function
    // is documented never to throw, so a failure here is surfaced the same
    // way the config-validation block above surfaces its `ConfigError`: a
    // `session_start` notification, never a thrown error. Skipped entirely
    // when this cwd is not a registered repo — that is the normal state for
    // most repos, not a failure to report (SPEC §3.11).
    if (!init.missingApiKey && isRepoRegistered()) {
      try {
        const entry = getEntry();
        const linear = getLinear();
        const teams = await linear.teams();
        const teamKey = await resolveTeamKey({ linear: { teams: async () => teams }, entryTeam: entry.team });
        const teamRef = teams.find((candidate) => candidate.key === teamKey);
        if (!teamRef) {
          throw new ConfigError(`Team "${teamKey}" was not found for the ensure pass`, [
            "the resolved team key no longer matches a team the credential can reach",
          ]);
        }
        /*
         * `YOLO_CONFIRMER`: `loop.mode` governs the supervisor's own terminal
         * (SPEC §17.9), and this ensure pass runs at `session_start` inside an
         * omp session with no operator to ask. The gate that applies here is
         * the agent session's own `approvalMode`, not the loop's.
         */
        const reports = await ensureMaintenanceProjects(linear, {
          initiativeIds: entry.initiativeIds,
          teamId: teamRef.id,
          confirmer: YOLO_CONFIRMER,
        });
        for (const report of reports) {
          if (report.created) {
            ctx.ui.notify(
              `Foreman: created the Maintenance project for initiative "${report.initiativeName}".`,
              "info",
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Foreman ensure pass failed: ${message}`, "error");
      }
    }

    if (!init.missingApiKey) {
      try {
        await sweep(getLinear(), new Date(), liveDispatchIds());
      } catch (error) {
        // Reaper sweep is best-effort at session start; a transient Linear
        // failure here must not block the session from starting.
        console.error(`[foreman] reaper sweep failed: ${String(error)}`);
      }
    }

    reaperTimer = ctx.setInterval(async () => {
      try {
        await sweep(getLinear(), new Date(), liveDispatchIds());
      } catch (error) {
        // Same rationale as above — the interval callback must never throw.
        console.error(`[foreman] reaper sweep failed: ${String(error)}`);
      }
    }, REAPER_INTERVAL_MS);
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (reaperTimer !== null) {
      ctx.clearTimer(reaperTimer);
      reaperTimer = null;
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
