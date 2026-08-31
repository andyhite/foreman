/**
 * The routing table (SPEC §17.1, §17.5–§17.9).
 *
 * Pure: every decision here is a predicate over already-fetched Linear state
 * plus config and bookkeeping counters. No network access, no model call —
 * that is the whole point of §17.1: putting an LLM in this path pays model
 * cost and adds nondeterminism to something fully determined.
 *
 * Each worker (`workers/*.ts`) fetches its own slice of Linear state into a
 * `BoardSnapshot`, calls `nextActions`, and dispatches only the decisions for
 * its own stage — this module decides for all four stages in one pass so that
 * global backpressure and the global WIP cap (§17.7, §17.6) are evaluated
 * exactly once, against one shared remaining-capacity counter, rather than
 * four workers racing four separate reads of the same limit.
 */

import type { GlobalConfig, Issue, ProjectRef } from "@foreman/core";
import {
  AGENT_LABEL,
  DISPATCH_COMMAND,
  LABEL_GROUP,
  hasLabel,
  implementationGate,
  labelsInGroup,
  priorityRank,
} from "@foreman/core";
import type { Bookkeeping } from "./bookkeeping.ts";

export type StageName = "refine" | "implement" | "review" | "plan";

export type ForemanAgentName = "foreman-refine" | "foreman-implement" | "foreman-review" | "foreman-plan";

const AGENT_BY_STAGE: Record<StageName, ForemanAgentName> = {
  refine: "foreman-refine",
  implement: "foreman-implement",
  review: "foreman-review",
  plan: "foreman-plan",
};

export interface DispatchDecision {
  agent: ForemanAgentName;
  issueId: string | null;
  /** Set only for `plan` decisions, which target a project rather than an issue. */
  projectId?: string | null;
  command: string;
  reason: string;
}

/**
 * Every issue considered and passed over, with a stable machine `code` so
 * `/foreman-status` can group and count them without parsing `message`
 * strings (SPEC §17.4's board reads this same shape).
 */
export interface SkipRecord {
  stage: StageName;
  issueId: string | null;
  /** Set only for `plan` skips, which target a project rather than an issue. */
  projectId?: string | null;
  code: string;
  message: string;
}

export interface ReviewCandidate {
  issue: Issue;
  /** True once a PR exists and is open (PR mode), or the branch is pushed (direct mode). */
  prOpen: boolean;
  headSha: string;
  /** True when a `ReviewResult` marker already exists for `headSha`. */
  hasReviewForHead: boolean;
}

/**
 * Pre-fetched Linear state, one field per worker's own view (SPEC §17.5's
 * table). `readyBufferCount` is the count of issues already satisfying
 * `readyFilter()` (Todo, `agent:ready`, estimate set, prioritized) — computed
 * by the caller from the live Linear query rather than re-derived here, so
 * this module never re-implements a filter that already exists in
 * `linear/filters.ts`.
 */
export interface BoardSnapshot {
  /** Backlog issues, plus `legacy` issues sitting in Backlog or Todo (SPEC §4.9). */
  backlog: Issue[];
  /** Todo issues, evaluated against the implementation gate. */
  todo: Issue[];
  /** In Review issues with their PR/head-SHA state. */
  reviewCandidates: ReviewCandidate[];
  /** Count of issues carrying any `blocked:*` label (SPEC §4.10.2). */
  blockedHumanCount: number;
  /** Current depth of the Ready buffer (SPEC §17.6). */
  readyBufferCount: number;
  /** In-scope, non-Maintenance projects that currently have zero issues (SPEC §7.6). */
  planCandidates: PlanCandidate[];
}

/** A bare project: in scope, not the standing Maintenance project, zero issues in any state. */
export interface PlanCandidate {
  project: ProjectRef;
}

export interface RoutingResult {
  decisions: DispatchDecision[];
  skipped: SkipRecord[];
}

/** Labels that suppress dispatch for every worker, checked first (SPEC §17.5). */
function suppressingLabel(issue: Issue): { code: string; message: string } | null {
  const blocked = labelsInGroup(issue, LABEL_GROUP.blocked)[0];
  if (blocked) {
    return { code: "suppressed-blocked", message: `Carries \`${blocked}\`.` };
  }
  if (hasLabel(issue, AGENT_LABEL.proposed)) {
    return {
      code: "suppressed-proposed",
      message: `Carries \`${AGENT_LABEL.proposed}\`.`,
    };
  }
  if (hasLabel(issue, AGENT_LABEL.running)) {
    return {
      code: "suppressed-running",
      message: `Carries \`${AGENT_LABEL.running}\` — already dispatched.`,
    };
  }
  if (hasLabel(issue, AGENT_LABEL.handsOff)) {
    return {
      code: "suppressed-hands-off",
      message: `Carries \`${AGENT_LABEL.handsOff}\`.`,
    };
  }
  return null;
}

/** Resolves a worker's autonomy rung, falling back to the global stage. */
export function effectiveStage(stage: StageName, loop: GlobalConfig["loop"]): GlobalConfig["loop"]["stage"] {
  return loop.workerStages[stage] ?? loop.stage;
}

/**
 * Whether routing may produce a dispatch intent. Dry-run intentionally permits
 * every worker to evaluate and report its intent; launch permission is handled
 * separately by the supervisor's worker context.
 */
export function stagePermitted(stage: StageName, loop: GlobalConfig["loop"]): boolean {
  const effective = effectiveStage(stage, loop);
  if (effective === "full") return true;
  if (effective === "read-only") return stage === "review";
  return effective === "dry-run";
}

/** Whether a worker may launch a selected dispatch, including the CLI safety override. */
export function dispatchPermitted(stage: StageName, loop: GlobalConfig["loop"], cliDryRun: boolean): boolean {
  if (cliDryRun) return false;
  const effective = effectiveStage(stage, loop);
  return effective === "full" || (effective === "read-only" && stage === "review");
}

/** Older first, then higher priority first — SPEC §17.5's pickup order. */
function byPriorityThenAge(a: Issue, b: Issue): number {
  const rankDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (rankDiff !== 0) return rankDiff;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

interface RoutingContext {
  decisions: DispatchDecision[];
  skipped: SkipRecord[];
  globalRemaining: number;
  stageRemaining: Record<StageName, number>;
  loop: GlobalConfig["loop"];
  /** Project ids that already have a `plan` dispatch in flight (SPEC §7.6) — prevents a second dispatch before the first's issues land. */
  planInFlightProjectIds: ReadonlySet<string>;
}

function pushSkip(ctx: RoutingContext, stage: StageName, issueId: string | null, code: string, message: string): void {
  ctx.skipped.push({ stage, issueId, code, message });
}

function pushProjectSkip(ctx: RoutingContext, stage: StageName, projectId: string, code: string, message: string): void {
  ctx.skipped.push({ stage, issueId: null, projectId, code, message });
}

/**
 * Shared per-candidate gauntlet: label suppression, backpressure, stage
 * permission, then WIP. Returns `true` when the candidate may proceed to its
 * stage-specific check; on any rejection it records the `SkipRecord` itself.
 */
function admitCandidate(
  ctx: RoutingContext,
  stage: StageName,
  issue: Issue,
  backpressureTripped: boolean,
): boolean {
  const suppressed = suppressingLabel(issue);
  if (suppressed) {
    pushSkip(ctx, stage, issue.identifier, suppressed.code, suppressed.message);
    return false;
  }
  if (backpressureTripped) {
    pushSkip(
      ctx,
      stage,
      issue.identifier,
      "backpressure-blocked-queue",
      "Blocked-human queue exceeds the backpressure threshold.",
    );
    return false;
  }
  const effective = effectiveStage(stage, ctx.loop);
  if (!stagePermitted(stage, ctx.loop)) {
    pushSkip(
      ctx,
      stage,
      issue.identifier,
      "stage-not-permitted",
      `Effective ${stage} stage "${effective}" does not permit dispatch.`,
    );
    return false;
  }
  if (ctx.globalRemaining <= 0) {
    pushSkip(ctx, stage, issue.identifier, "wip-global-full", "Global WIP cap reached.");
    return false;
  }
  const stageLimit = ctx.loop.wip[stage];
  if (ctx.stageRemaining[stage] <= 0) {
    pushSkip(ctx, stage, issue.identifier, "wip-stage-full", `${stage} WIP cap (${stageLimit}) reached.`);
    return false;
  }
  return true;
}

function admitDecision(ctx: RoutingContext, stage: StageName): void {
  ctx.globalRemaining -= 1;
  ctx.stageRemaining[stage] -= 1;
}

function routeRefine(ctx: RoutingContext, snapshot: BoardSnapshot, backpressureTripped: boolean): void {
  if (snapshot.readyBufferCount >= ctx.loop.readyBufferTarget) {
    for (const issue of snapshot.backlog) {
      pushSkip(
        ctx,
        "refine",
        issue.identifier,
        "buffer-satisfied",
        `Ready buffer at ${snapshot.readyBufferCount}/${ctx.loop.readyBufferTarget}.`,
      );
    }
    return;
  }

  const candidates = [...snapshot.backlog].sort(byPriorityThenAge);
  for (const issue of candidates) {
    if (issue.priority === 0) {
      pushSkip(ctx, "refine", issue.identifier, "unprioritized", "Priority is None.");
      continue;
    }
    if (!admitCandidate(ctx, "refine", issue, backpressureTripped)) continue;
    if (hasLabel(issue, AGENT_LABEL.ready)) {
      pushSkip(ctx, "refine", issue.identifier, "has-agent-label", "Already carries `agent:ready`.");
      continue;
    }
    if (snapshot.readyBufferCount + ctx.decisions.filter((d) => d.agent === "foreman-refine").length >=
      ctx.loop.readyBufferTarget) {
      pushSkip(ctx, "refine", issue.identifier, "buffer-satisfied", "Ready buffer reached target mid-pass.");
      continue;
    }
    ctx.decisions.push({
      agent: "foreman-refine",
      issueId: issue.identifier,
      command: `${DISPATCH_COMMAND.refine} ${issue.identifier}`,
      reason: `Backlog, priority ${issue.priority}, buffer below target.`,
    });
    admitDecision(ctx, "refine");
  }
}

function routeImplement(ctx: RoutingContext, snapshot: BoardSnapshot, backpressureTripped: boolean): void {
  const candidates = [...snapshot.todo].sort(byPriorityThenAge);
  for (const issue of candidates) {
    if (!admitCandidate(ctx, "implement", issue, backpressureTripped)) continue;
    const gate = implementationGate(issue);
    if (!gate.ok) {
      const first = gate.failures[0];
      pushSkip(
        ctx,
        "implement",
        issue.identifier,
        `gate-failed:${first?.code ?? "unknown"}`,
        first?.message ?? "Implementation gate failed.",
      );
      continue;
    }
    ctx.decisions.push({
      agent: "foreman-implement",
      issueId: issue.identifier,
      command: `${DISPATCH_COMMAND.implement} ${issue.identifier}`,
      reason: "Implementation gate passes.",
    });
    admitDecision(ctx, "implement");
  }
}

function routeReview(ctx: RoutingContext, snapshot: BoardSnapshot, backpressureTripped: boolean): void {
  const candidates = [...snapshot.reviewCandidates].sort((a, b) => byPriorityThenAge(a.issue, b.issue));
  for (const candidate of candidates) {
    const { issue } = candidate;
    if (!admitCandidate(ctx, "review", issue, backpressureTripped)) continue;
    if (!candidate.prOpen) {
      pushSkip(ctx, "review", issue.identifier, "pr-not-open", "No open PR (or pushed branch) for this issue.");
      continue;
    }
    if (candidate.hasReviewForHead) {
      pushSkip(ctx, "review", issue.identifier, "already-reviewed", `Already reviewed at ${candidate.headSha}.`);
      continue;
    }
    ctx.decisions.push({
      agent: "foreman-review",
      issueId: issue.identifier,
      command: `${DISPATCH_COMMAND.review} ${issue.identifier}`,
      reason: `No ReviewResult for head ${candidate.headSha}.`,
    });
    admitDecision(ctx, "review");
  }
}

/**
 * A project becomes a candidate the moment it is in scope, not the standing
 * Maintenance project, and carries zero issues in any state (SPEC §7.6) — a
 * bare project can't ship anything. Once `foreman-plan` creates its first
 * issue the project drops out of `planCandidates` on the next tick, so no
 * separate "fully planned" flag is needed; Linear's own state is the stop
 * condition. `planInFlightProjectIds` covers the one gap that leaves: a
 * dispatch already running whose issues haven't landed yet.
 */
function routePlan(ctx: RoutingContext, snapshot: BoardSnapshot, backpressureTripped: boolean): void {
  for (const candidate of snapshot.planCandidates) {
    const { project } = candidate;
    if (ctx.planInFlightProjectIds.has(project.id)) {
      pushProjectSkip(ctx, "plan", project.id, "already-in-flight", `"${project.name}" already has a plan dispatch in flight.`);
      continue;
    }
    if (backpressureTripped) {
      pushProjectSkip(ctx, "plan", project.id, "backpressure-blocked-queue", "Blocked-human queue exceeds the backpressure threshold.");
      continue;
    }
    const effective = effectiveStage("plan", ctx.loop);
    if (!stagePermitted("plan", ctx.loop)) {
      pushProjectSkip(ctx, "plan", project.id, "stage-not-permitted", `Effective plan stage "${effective}" does not permit dispatch.`);
      continue;
    }
    if (ctx.globalRemaining <= 0) {
      pushProjectSkip(ctx, "plan", project.id, "wip-global-full", "Global WIP cap reached.");
      continue;
    }
    if (ctx.stageRemaining.plan <= 0) {
      pushProjectSkip(ctx, "plan", project.id, "wip-stage-full", `plan WIP cap (${ctx.loop.wip.plan}) reached.`);
      continue;
    }
    ctx.decisions.push({
      agent: "foreman-plan",
      issueId: null,
      projectId: project.id,
      command: `${DISPATCH_COMMAND.plan} ${project.id}`,
      reason: `"${project.name}" has no issues yet.`,
    });
    admitDecision(ctx, "plan");
  }
}


/**
 * The heart of the loop (SPEC §17.1). Every decision here is a predicate over
 * `snapshot` — no network access, no model call. `bookkeeping` supplies the
 * in-flight counts that back the WIP checks.
 */
export function nextActions(
  snapshot: BoardSnapshot,
  config: GlobalConfig,
  bookkeeping: Bookkeeping,
): RoutingResult {
  const loop = config.loop;
  const backpressureTripped = snapshot.blockedHumanCount > loop.backpressureThreshold;

  const stageRemaining: Record<StageName, number> = {
    refine: Math.max(0, loop.wip.refine - bookkeeping.countInFlight("refine")),
    implement: Math.max(0, loop.wip.implement - bookkeeping.countInFlight("implement")),
    review: Math.max(0, loop.wip.review - bookkeeping.countInFlight("review")),
    plan: Math.max(0, loop.wip.plan - bookkeeping.countInFlight("plan")),
  };
  const ctx: RoutingContext = {
    decisions: [],
    skipped: [],
    globalRemaining: Math.max(0, loop.wipGlobal - bookkeeping.totalInFlight()),
    stageRemaining,
    loop,
    planInFlightProjectIds: bookkeeping.inFlightProjectIds("plan"),
  };

  routePlan(ctx, snapshot, backpressureTripped);
  routeRefine(ctx, snapshot, backpressureTripped);
  routeImplement(ctx, snapshot, backpressureTripped);
  routeReview(ctx, snapshot, backpressureTripped);

  return { decisions: ctx.decisions, skipped: ctx.skipped };
}

export { AGENT_BY_STAGE };
