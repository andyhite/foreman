/**
 * Foreman's omp extension factory (SPEC §3.5). Wires the two tools, the four
 * commands, and every event the extension owns: `session_start` (config
 * validation, skill guard, reaper sweep + timer), `tool_call` (the task
 * guard), `tool_result` and the three `task:subagent:*` events (result
 * capture), and `session_shutdown` (clear timers).
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallDecision, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { BlockRecord } from "@foreman/core";
import {
  AGENT_OUTPUT_SCHEMAS,
  ConfigError,
  ensureMaintenanceProjects,
  ensureWorktree,
  isBudgetTruncation,
  newDispatchId,
  parseAgentOutput,
  resolveTeamKey,
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
import { applyOutcome, markApplied, type ApplyDeps, type AgentOutcome } from "./results/apply.ts";
import { extractFromLifecycle, extractFromToolResult, sink, type AppliedTracker } from "./results/sink.ts";
import { getConfig, getEntry, getGitHub, getLinear, getContextDigest, initRuntime, isRepoRegistered, resetRuntime } from "./runtime.ts";

const REAPER_INTERVAL_MS = 5 * 60 * 1000;

function liveDispatchIds(): readonly string[] {
  return [];
}

function toApplyDeps(): ApplyDeps {
  return { linear: getLinear(), github: getGitHub(), now: () => new Date() };
}

function toGuardDeps(pluginRoot: string): TaskGuardDeps {
  return {
    linear: getLinear(),
    github: getGitHub(),
    config: getConfig(),
    entry: getEntry(),
    now: () => new Date(),
    newDispatchId: (agent, issueId, now) => newDispatchId(agent, issueId, now),
    ensureWorktree: (input) => ensureWorktree(input),
    writeDiffFile: async (issueId, diff) => {
      const dir = mkdtempSync(join(tmpdir(), `foreman-review-${issueId}-`));
      const path = join(dir, "diff.patch");
      writeFileSync(path, diff);
      return path;
    },
    liveDispatchIds,
    contextDigest: async (projectId) => (projectId ? getContextDigest(projectId) : ""),
  };
}

function markerAppliedTracker(): AppliedTracker {
  return {
    wasApplied: async (dispatchId: string) => {
      const linear = getLinear();
      // A dispatch id is greppable, so its `foreman:applied` marker is found
      // by scanning the issue named in its own `FOREMAN-ISSUE` marker; the
      // sink only has the dispatch id, so this reads it back off the issue
      // whose identifier is embedded in the dispatch id itself
      // (`<agent>-<ISSUE-ID>-<timestamp>-<suffix>`, per `newDispatchId`).
      const match = /^foreman-[a-z]+-(\S+)-\d{8}T\d{6}Z-\w+$/.exec(dispatchId);
      const issueId = match?.[1];
      if (!issueId) return false;
      const issue = await linear.issue(issueId, { includeComments: true });
      if (!issue) return false;
      return issue.comments.some((comment) => comment.body.includes(`"dispatchId":"${dispatchId}"`));
    },
  };
}

/** Converts a raw agent yield into the `AgentOutcome` union `applyOutcome` consumes. */
function toOutcome(agentName: ForemanAgentName, data: unknown): AgentOutcome | null {
  if (agentName === "foreman-triage") {
    const parsed = parseAgentOutput(agentName, data);
    if (parsed.kind === "invalid") return null;
    if (parsed.kind === "blocked") return blockedOutcome(agentName, parsed.block);
    return { kind: "result", agent: agentName, result: parsed.result };
  }
  if (agentName === "foreman-refine") {
    const parsed = parseAgentOutput(agentName, data);
    if (parsed.kind === "invalid") return null;
    if (parsed.kind === "blocked") return blockedOutcome(agentName, parsed.block);
    return { kind: "result", agent: agentName, result: parsed.result };
  }
  if (agentName === "foreman-implement") {
    const parsed = parseAgentOutput(agentName, data);
    if (parsed.kind === "invalid") return null;
    if (parsed.kind === "blocked") return blockedOutcome(agentName, parsed.block);
    return { kind: "result", agent: agentName, result: parsed.result };
  }
  const parsed = parseAgentOutput(agentName, data);
  if (parsed.kind === "invalid") return null;
  if (parsed.kind === "blocked") return blockedOutcome(agentName, parsed.block);
  return { kind: "result", agent: agentName, result: parsed.result };
}

function blockedOutcome(agentName: ForemanAgentName, block: BlockRecord): AgentOutcome {
  return { kind: "blocked", agent: agentName, block, issueId: block.blockedByIssues[0] ?? "" };
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
  return outcome.result.issueId;
}

function isForemanAgentName(agent: string): agent is ForemanAgentName {
  return agent in AGENT_OUTPUT_SCHEMAS;
}

async function handleCaptured(dispatchId: string, agent: string, data: unknown): Promise<void> {
  if (!isForemanAgentName(agent)) return;
  const agentName = agent;

  const tracker = markerAppliedTracker();
  await sink({ dispatchId, agent: agentName, data }, tracker, async (captured) => {
    const outcome = toOutcome(agentName, captured.data);
    if (!outcome) return;
    const deps = toApplyDeps();
    await applyOutcome(deps, outcome);
    const issueId = issueIdOf(outcome);
    if (issueId) await markApplied(deps, issueId, captured.dispatchId);
  });
}

/**
 * The plugin directory, derived from this module's own location rather than
 * received as an argument: omp calls the factory with `(pi)` alone, so an
 * `options.pluginRoot` parameter is `undefined` at load time and takes the
 * whole extension down with it. Both the source (`src/extension.ts`) and the
 * bundle (`dist/extension.js`) sit one level below the plugin root.
 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Foreman's extension factory. omp calls this once per session with the loaded `ExtensionAPI`. */
export default function createForemanExtension(pi: ExtensionAPI) {
  pi.setLabel("Foreman");

  registerLinearReadTool(pi);
  registerGitHubPrTool(pi);

  const commandName = (key: keyof typeof COMMAND_NAMES): string => COMMAND_NAMES[key];

  pi.registerCommand(commandName("status"), {
    description: "Foreman operator console: blocked queue, locks, proposals, agents, loop state.",
    handler: async (_args, ctx: ExtensionContext) => {
      const text = await renderStatus(getLinear());
      await pi.sendMessage({ customType: "foreman.status", content: text, display: true, attribution: "assistant" }, { triggerTurn: false });
    },
  });

  pi.registerCommand(commandName("apply"), {
    description: "Apply approved triage proposals, or approve/reject one by issue id.",
    handler: async (args: string) => {
      const argv = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
      const result = await runApplyCommand(getLinear(), argv);
      const lines = [result.message];
      if (result.plan) {
        for (const entry of result.plan) lines.push(`- ${entry.issueId}: ${entry.item.type} → ${entry.item.destination}`);
      }
      await pi.sendMessage(
        { customType: "foreman.apply", content: lines.join("\n"), display: true, attribution: "assistant" },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand(commandName("merge"), {
    description: "Merge one issue's PR (or branch) once the review gate passes. Operator-invoked only.",
    handler: async (args: string) => {
      const issueId = args.trim();
      if (!issueId) {
        await pi.sendMessage(
          { customType: "foreman.merge", content: "Usage: /foreman:merge <ISSUE-ID>", display: true, attribution: "assistant" },
          { triggerTurn: false },
        );
        return;
      }
      const result = await runMerge(getLinear(), getGitHub(), issueId);
      await pi.sendMessage(
        { customType: "foreman.merge", content: result.message, display: true, attribution: "assistant" },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand(commandName("unblock"), {
    description: "Record the operator's reply to a blocked issue and clear its blocked:* label.",
    handler: async (args: string) => {
      const [issueId, ...replyParts] = args.trim().split(/\s+/);
      const reply = replyParts.join(" ");
      if (!issueId) {
        await pi.sendMessage(
          { customType: "foreman.unblock", content: "Usage: /foreman:unblock <ISSUE-ID> <reply>", display: true, attribution: "assistant" },
          { triggerTurn: false },
        );
        return;
      }
      const result = await runUnblock(getLinear(), issueId, reply);
      await pi.sendMessage(
        { customType: "foreman.unblock", content: result.message, display: true, attribution: "assistant" },
        { triggerTurn: false },
      );
    },
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
        const reports = await ensureMaintenanceProjects(linear, {
          initiativeIds: entry.initiativeIds,
          teamId: teamRef.id,
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
    const guardDeps = toGuardDeps(PLUGIN_ROOT);
    const decision = await prepareTaskCall(event.input as TaskCallInput, guardDeps);
    if (decision.block) return { block: true, reason: decision.reason };
    return { input: decision.input };
  });

  pi.on("tool_result", async (event: ToolResultEvent) => {
    if (event.toolName !== "task") return;
    const captured = extractFromToolResult(event);
    for (const item of captured) await handleCaptured(item.dispatchId, item.agent, item.data);
  });

  const lifecycleHandler = async (payload: unknown) => {
    const captured = extractFromLifecycle(payload);
    if (captured) await handleCaptured(captured.dispatchId, captured.agent, captured.data);
  };
  pi.on("task:subagent:lifecycle", lifecycleHandler);
  pi.on("task:subagent:progress", lifecycleHandler);
  pi.on("task:subagent:event", lifecycleHandler);

  return {};
}
