/**
 * `foreman team` — the team-level triage process (SPEC §3.12).
 *
 * Named for the scope it manages — one process per team — distinct from
 * `foreman repo` (`repo.ts`), which manages a single repo. One process for
 * the whole team, separate from the per-repo `foreman repo` instances
 * (§3.11): the shared Triage inbox is a single queue, and a single consumer
 * is strictly simpler than N repo-scoped instances negotiating over it.
 * It is a singleton (its own lockfile), dispatches `foreman-triage` on its
 * own window, and runs the apply pass (§7.1) on every tick so approvals are
 * picked up without a manual `/foreman-apply`.
 *
 * Hand-rolled argument parsing, same rationale as `foreman repo`: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { HerdrDispatcher, PrintDispatcher } from "./dispatch/index.ts";
import {
  activateRepoPlugin,
  BATCH_SUBJECT,
  ControlServer,
  DISPATCH_COMMAND,
  INBOX_FILTER,
  INTAKE_LOOP_ID,
  LinearClient,
  PROPOSALS_FILTER,
  emptyBoardCounts,
  expandHome,
  findApprovedUnapplied,
  initiativeIndex,
  loadGlobalConfig,
  lockTtlMs,
  loopPaths,
  newDispatchId,
  reservationsPath,
  reserveDispatches,
  resolveLinearApiKey,
  resolveRepoEntry,
  resolveTeamKey,
  runApplyPass,
  writeStatusFile,
  TtyConfirmer,
  verboseConfirmer,
  YOLO_CONFIRMER,
  type ConfirmRequest,
  type Confirmer,
  type AgentReport,
  type ControlEvent,
  type ControlHandlers,
  type Dispatcher,
  type EmittableEvent,
  type LinearRequestEvent,
  type GlobalConfig,
  type Issue,
  type LinearWriter,
  type LoopSnapshot,
  type ResolvedRepoEntry,
  type RunState,
  style,
} from "@foreman/core";
import { Bookkeeping } from "./bookkeeping";
import { patchAndWriteGlobalConfig } from "./control";
import { buildSnapshot } from "./snapshot";
import {
  bookkeepingPathFor,
  lockPathFor,
  resolveDispatcher,
  SupervisorLock,
} from "./supervisor.ts";
import { LOOP_VERSION } from "./version.ts";

interface ParsedArgs {
  team: string | null;
  once: boolean;
  verbose: boolean;
  homePath: string | null;
  noControl: boolean;
  herdrLayout: "tab" | "pane" | null;
  help: boolean;
}

const HELP_TEXT = `foreman team — team-level triage process (SPEC §3.12)

Usage: foreman team [key] [options]

  [key]                   Linear team key. Defaults to the sole team the credential can reach.
  --once                  Run one tick, then exit.
  --verbose               Log skip reasons, Linear request tracing, auto-approved actions, and full error stacks.
  --home <path>           Home directory containing .foreman/config.json (default: real home).
  --no-control            Skip the control-plane socket/status.json; --once already implies this.
  --herdr-layout <l>      Override agent.herdrLayout: tab | pane.
  --help                  Show this text.

Team-level: one process per team, not per repo. Per-repo work is
\`foreman repo\`.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    team: null,
    once: false,
    verbose: false,
    homePath: null,
    noControl: false,
    herdrLayout: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--once":
        parsed.once = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--no-control":
        parsed.noControl = true;
        break;
      case "--herdr-layout": {
        if (i + 1 >= argv.length) throw new Error("missing value for --herdr-layout");
        const value = argv[++i];
        if (value !== "tab" && value !== "pane") {
          throw new Error(`--herdr-layout must be one of tab|pane, got "${value ?? ""}"`);
        }
        parsed.herdrLayout = value;
        break;
      }
      case "--home": {
        if (i + 1 >= argv.length) throw new Error("missing value for --home");
        const value = argv[++i];
        if (!value) throw new Error("--home requires a path");
        parsed.homePath = value;
        break;
      }
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default: {
        if (!arg || arg.startsWith("-")) throw new Error(`Unrecognized argument: ${arg ?? ""}`);
        if (parsed.team !== null) throw new Error(`Unexpected positional argument: ${arg}`);
        parsed.team = arg;
        break;
      }
    }
  }
  return parsed;
}

/** `"HH:MM"` window compared against `now`'s time-of-day in `timezone` (an IANA zone name), once per calendar day. */
export function pastIntakeWindow(window: string, now: Date, timezone: string): boolean {
  const [hourStr, minuteStr] = window.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const nowHour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const nowMinute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const nowMinutes = nowHour * 60 + nowMinute;
  return nowMinutes >= hour * 60 + minute;
}

/** `YYYY-MM-DD` in `timezone` — the calendar day `intake.window` is evaluated against, not the host's. */
export function intakeDayKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    at,
  );
}

/**
 * Resolves the initiative bound to `issue`'s project, then the registry
 * alias and repo entry bound to it (SPEC §3.12). An initiative bound to no
 * registry entry — or an issue with no project at all — still gets
 * classified and drafted, just without repro; this returns `null` rather
 * than throwing.
 */
export async function repoEntryForIssue(
  linear: Pick<LinearWriter, "projectInitiative">,
  index: Record<string, string>,
  config: GlobalConfig,
  issue: Issue,
): Promise<ResolvedRepoEntry | null> {
  if (!issue.project) return null;
  let initiativeId: string;
  try {
    const initiative = await linear.projectInitiative(issue.project.id);
    initiativeId = initiative.id;
  } catch {
    return null;
  }
  const alias = index[initiativeId];
  if (!alias) return null;
  try {
    return resolveRepoEntry(config, alias);
  } catch {
    return null;
  }
}

/**
 * Refreshes `<scratchCwd>/repos/`: one symlink per registered repo alias,
 * pointing at that repo's real working tree. `foreman-triage` holds no
 * config-reading tool (SPEC §3.12), so this is the only way it can reach
 * real code for repro without ever seeing `~/.foreman/config.json`.
 *
 * Recreated from scratch on every tick rather than diffed — `repos/` is
 * disposable scratch state, and a stale symlink to a deregistered or moved
 * repo is worse than the cost of relinking everything each time. An alias
 * whose path no longer resolves on disk is skipped and logged rather than
 * failing the tick, mirroring `repoEntryForIssue`'s non-fatal handling of
 * an initiative bound to no registry entry.
 */
function ensureRepoLinks(scratchCwd: string, config: GlobalConfig, log: (message: string) => void): void {
  const reposDir = `${scratchCwd}/repos`;
  rmSync(reposDir, { recursive: true, force: true });
  mkdirSync(reposDir, { recursive: true });
  for (const alias of Object.keys(config.repos)) {
    const { repoPath } = resolveRepoEntry(config, alias);
    if (!existsSync(repoPath)) {
      log(style("yellow", `~ repos.${alias} points at ${repoPath}, which does not exist — skipping its repro symlink`));
      continue;
    }
    symlinkSync(repoPath, `${reposDir}/${alias}`);
  }
}

/**
 * Writes `<scratchCwd>/repos/index.json`: issue identifier → repro alias,
 * for every batch item whose initiative resolves to a registered repo.
 * `ensureRepoLinks` makes the code reachable; this is what tells
 * `foreman-triage` — which cannot compute the mapping itself, for the same
 * config-reading-tool reason — which `repos/<alias>` (if any) to read for
 * each item. Built from `repoEntryForIssue`, so the two never disagree
 * about how an issue resolves to a repo.
 */
async function writeRepoManifest(
  scratchCwd: string,
  linear: Pick<LinearWriter, "projectInitiative">,
  index: Record<string, string>,
  config: GlobalConfig,
  inbox: readonly Issue[],
): Promise<void> {
  const manifest: Record<string, { alias: string; path: string } | null> = {};
  for (const issue of inbox) {
    const entry = await repoEntryForIssue(linear, index, config, issue);
    manifest[issue.identifier] = entry ? { alias: entry.alias, path: `repos/${entry.alias}` } : null;
  }
  writeFileSync(`${scratchCwd}/repos/index.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export interface IntakeContext {
  config: GlobalConfig;
  linear: LinearWriter;
  dispatcher: Dispatcher;
  /** Directory of per-agent dispatch-id reservation files (SPEC §17.4) — `loopPaths(...).reservations`. */
  reservationsDir: string;
  bookkeeping: Bookkeeping;
  team: string;
  now: () => Date;
  log: (message: string) => void;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /**
   * Makes Foreman's omp plugin discoverable from `repoRoot` (SPEC §3.12) —
   * `scratchCwd` is a synthetic workspace with no `foreman init` of its own
   * to have activated it, so `runIntakeTick` calls this itself before
   * dispatching `foreman-triage` there. Real wiring is
   * `activateRepoPlugin` (`@foreman/core`); throwing here surfaces as the
   * same dispatch-failure `skipReason` a Linear or reservation error would.
   */
  ensurePluginActive(repoRoot: string): void;
  /** `--verbose`: full error stacks alongside the one-line failures already logged unconditionally. */
  verbose?: boolean;
}

export interface IntakeTickReport {
  ranAt: string;
  dispatched: boolean;
  skipReason: string | null;
  proposedCount: number;
  applyPassRan: boolean;
  appliedCount: number;
  /** How many approved proposals were left unapplied because the operator declined the apply-pass confirmation. */
  declinedApplyCount: number;
}

/**
 * One intake tick: team-wide proposal backpressure (§17.7), the daily
 * triage-batch dispatch on `config.intake.window`, and the apply pass
 * (§7.1) — which runs every tick regardless of the window or backpressure
 * outcome, so approvals are picked up without a manual `/foreman-apply`.
 */
export async function runIntakeTick(ctx: IntakeContext): Promise<IntakeTickReport> {
  const now = ctx.now();

  const proposed = await ctx.linear.issues({ filter: PROPOSALS_FILTER, limit: 500 });
  const proposedCount = proposed.length;
  const backpressureTripped = proposedCount > ctx.config.loop.backpressureThreshold;

  let dispatched = false;
  let skipReason: string | null = null;

  if (backpressureTripped) {
    skipReason = `team-wide proposal backpressure: ${proposedCount} proposed > threshold ${ctx.config.loop.backpressureThreshold}`;
    ctx.log(style("yellow", skipReason));
  } else {
    const lastRunAt = ctx.bookkeeping.state.lastTriageRunAt;
    const alreadyRanToday =
      lastRunAt !== null &&
      intakeDayKey(new Date(lastRunAt), ctx.config.intake.timezone) === intakeDayKey(now, ctx.config.intake.timezone);
    if (!pastIntakeWindow(ctx.config.intake.window, now, ctx.config.intake.timezone)) {
      skipReason = `before intake.window (${ctx.config.intake.window})`;
    } else if (alreadyRanToday) {
      skipReason = "already dispatched the intake batch today";
    } else {
      const inbox = await ctx.linear.issues({ filter: INBOX_FILTER, limit: ctx.config.intake.batchSize });
      if (inbox.length === 0) {
        skipReason = "inbox empty";
      } else {
        const scratchCwd = `${expandHome(ctx.config.loop.stateDir)}/intake/scratch`;
        const identifiers = inbox.map((issue) => issue.identifier).join(" ");
        const command = `${DISPATCH_COMMAND.triage} --stale-low-days ${ctx.config.intake.staleLowDays} ${identifiers}`;
        const approved = await ctx.confirm({
          kind: "dispatch",
          summary: `dispatch foreman-triage for the triage batch (${inbox.length} items)`,
          detail: [`command: ${command}`, `cwd: ${scratchCwd}`],
        });
        if (!approved) {
          skipReason = "operator declined";
        } else {
          try {
            // The triage stage has no repo checkout of its own (SPEC §3.12)
            // — `scratchCwd` is a synthetic workspace, not a git repo, so
            // unlike every per-repo dispatch (plan/refine/review/implement,
            // which reuse `ctx.entry.repoPath`) it is never created by
            // another process and must be ensured here before the
            // dispatcher (herdr `workspace create --cwd`) is handed a path
            // that doesn't exist yet. Likewise, unlike a registered repo —
            // activated once by `foreman init` — the scratch workspace has
            // no activation step of its own, so `foreman-triage` would
            // dispatch into a cwd with none of the plugin's tools or
            // skills discoverable; `ensurePluginActive` makes that surface
            // present before every dispatch, idempotently.
            mkdirSync(scratchCwd, { recursive: true });
            ctx.ensurePluginActive(scratchCwd);
            // Gives foreman-triage what its "Required reads" section
            // promises — real code for repro — without a config-reading
            // tool of its own: a symlink per registered repo, plus
            // repos/index.json naming which one (if any) applies to each
            // item in this batch (SPEC §3.12).
            ensureRepoLinks(scratchCwd, ctx.config, ctx.log);
            await writeRepoManifest(scratchCwd, ctx.linear, initiativeIndex(ctx.config), ctx.config, inbox);
            const dispatchId = newDispatchId("foreman-triage", "batch", now);
            reserveDispatches(
              reservationsPath(ctx.reservationsDir, "foreman-triage"),
              [{ agent: "foreman-triage", subject: BATCH_SUBJECT, dispatchId, reservedAt: now.toISOString() }],
              now,
              lockTtlMs(ctx.config),
            );
            const handles = await ctx.dispatcher.dispatch({
              agent: "foreman-triage",
              // The triage agent holds no config-reading tool, so the dispatch
              // command is the only channel that carries `intake.staleLowDays`
              // (SPEC §3.10, §3.12) — the same channel `intake.batchSize`
              // already uses to size `identifiers` above. `subject` stays null:
              // the whole identifier list is already embedded in `command`
              // above, so nothing needs appending (SPEC §17.4's `BATCH_SUBJECT`
              // is only the reservation key for this one item).
              command,
              cwd: scratchCwd,
              alias: "intake",
              items: [{ issueId: null, subject: null, dispatchId, worktree: null }],
            });
            void handles;
            ctx.bookkeeping.setLastTriageRun(now);
            ctx.bookkeeping.setLastRun("intake", now);
            dispatched = true;
          } catch (error) {
            skipReason = `dispatch ${DISPATCH_COMMAND.triage} failed: ${String(error)}`;
            if (ctx.verbose && error instanceof Error && error.stack) ctx.log(style("dim", `  · ${error.stack}`));
          }
        }
      }
    }
  }

  // Apply pass (SPEC §7.1, §3.12): runs every tick regardless of the
  // dispatch outcome above, so an approved proposal is applied to Linear
  // without waiting for the operator to type `/foreman-apply`. Reuses the
  // core apply engine — the same `runApplyPass` the extension's
  // `/foreman-apply` command drives — rather than reimplementing the
  // deterministic apply logic here. SPEC principle 9 still holds: this
  // only forwards the `LinearWriter` already supplied on `ctx`, it never
  // constructs a write client.
  //
  // Scoped to the Triage state rather than the whole team: proposals are
  // written on Triage-state issues (SPEC §4.10.1/§4.10.4 — `agent:proposed`
  // is removed on approval, so that label can't be filtered on here) and
  // applying is what moves an issue out of Triage, so a Triage-state scan
  // covers every possible unapplied proposal at a fraction of a team-wide
  // scan's cost. `INBOX_FILTER` already encodes exactly that state filter,
  // so it is reused rather than re-declaring the state name.
  //
  // `runApplyPass` sets state, labels, priority, project, relations and
  // posts a comment — a Linear mutation, so it goes through `ctx.confirm`
  // first (SPEC §17.9) using the count `findApprovedUnapplied` already
  // reads read-only. A single bad proposal (e.g. a Linear 4xx applying one
  // issue) must not stop this tick's bookkeeping from being saved, so
  // failures are logged and swallowed here the same way a failed triage
  // dispatch above is.
  let appliedCount = 0;
  let declinedApplyCount = 0;
  try {
    let viewerId: string | null;
    try {
      viewerId = await ctx.linear.viewerId();
    } catch {
      viewerId = null;
    }
    if (viewerId === null) {
      ctx.log(style("yellow", "~ apply pass: viewer id unavailable; skipping (marker authorship unverifiable)."));
    } else {
      const candidates = await findApprovedUnapplied(ctx.linear, { filter: INBOX_FILTER, authoredBy: viewerId });
      if (candidates.length === 0) {
        ctx.log(`${style("dim", "○")} apply pass: no approvals pending.`);
      } else {
        const approved = await ctx.confirm({
          kind: "linear-write",
          summary: `apply ${candidates.length} approved triage proposal(s)`,
        });
        if (!approved) {
          declinedApplyCount = candidates.length;
          ctx.log(style("yellow", `~ apply pass: operator declined applying ${candidates.length} approved proposal(s).`));
        } else {
          const { applied, failures } = await runApplyPass(ctx.linear, { filter: INBOX_FILTER, authoredBy: viewerId });
          appliedCount = applied.length;
          if (applied.length === 0) {
            ctx.log(`${style("dim", "○")} apply pass: no approvals pending.`);
          } else {
            const identifiers = applied.map((proposal) => proposal.identifier).join(", ");
            ctx.log(`${style("green", "✓")} apply pass: applied ${applied.length} approved proposal(s) — ${identifiers}.`);
          }
          for (const failure of failures) {
            ctx.log(style("red", `apply pass: failed to apply ${failure.identifier} (${failure.issueId}): ${failure.error}`));
          }
        }
      }
    }
  } catch (error) {
    ctx.log(`apply pass failed: ${String(error)}`);
    if (ctx.verbose && error instanceof Error && error.stack) ctx.log(style("dim", `  · ${error.stack}`));
  }

  ctx.bookkeeping.save();

  return {
    ranAt: now.toISOString(),
    dispatched,
    skipReason,
    proposedCount,
    applyPassRan: true,
    appliedCount,
    declinedApplyCount,
  };
}

/**
 * The intake process's control-plane state (SPEC §17, contract §I–§M):
 * everything `createIntakeControlHandlers`/`buildIntakeSnapshot` need that
 * isn't already on `IntakeContext`. Kept as one small mutable class rather
 * than folding into `IntakeContext` itself, so `runIntakeTick` — the unit
 * this file already tests — stays a pure function of `IntakeContext` with
 * no control-plane awareness.
 */
class IntakeRuntime {
  runState: RunState = "starting";
  pausedAt: string | null = null;
  ticks = 0;
  lastTickAt: string | null = null;
  lastReport: IntakeTickReport | null = null;
  wake: (() => void) | null = null;
  tickRequested = false;
  stopMode: "graceful" | "now" | null = null;
  stopped = false;
  readonly startedAt = new Date().toISOString();
  readonly listeners = new Set<(event: ControlEvent) => void>();
  #seq = 0;

  /**
   * The run state, read through a call rather than the field.
   *
   * `runState = "running"` before the poll loop narrows the property to that
   * literal for the rest of the block, and TypeScript keeps the narrowing
   * across every `await` in the loop body — so a later `=== "draining"` is
   * reported as a comparison between non-overlapping literals even though
   * `stop` writes exactly that value from another turn. A call boundary
   * returns the declared type and stays honest. `Supervisor` reads its own
   * state the same way, for the same reason.
   */
  currentRunState(): RunState {
    return this.runState;
  }

  emit(event: EmittableEvent, now: () => Date): void {
    this.#seq += 1;
    const full = { ...event, seq: this.#seq, at: now().toISOString() } as ControlEvent;
    for (const listener of this.listeners) listener(full);
  }
}

function buildIntakeSnapshot(ctx: IntakeContext, runtime: IntakeRuntime, version: string): LoopSnapshot {
  return buildSnapshot({
    loopId: INTAKE_LOOP_ID,
    kind: "intake",
    label: "intake",
    alias: null,
    team: ctx.team,
    repoPath: null,
    initiativeIds: [],
    pid: process.pid,
    startedAt: runtime.startedAt,
    version,
    config: ctx.config,
    runState: runtime.runState,
    dispatcherKind: ctx.dispatcher.kind,
    pausedAt: runtime.pausedAt,
    lastTickAt: runtime.lastTickAt,
    ticks: runtime.ticks,
    now: ctx.now(),
    workers: [
      {
        name: "intake",
        cadenceMs: 60_000,
        lastRunAt: ctx.bookkeeping.state.lastRunAt.intake,
        running: false,
        lastReport: null,
      },
    ],
    bookkeeping: ctx.bookkeeping.state,
    agentStatuses: new Map(),
    boardCounts: {
      ...emptyBoardCounts(),
      proposals: runtime.lastReport?.proposedCount ?? 0,
      triageInbox: 0,
    },
    linear: { ok: true, lastPollAt: runtime.lastTickAt, lastError: null, requests: 0 },
    dispatchHistory: [],
  });
}

/** Atomic write of `status.json`, guarded the way `Supervisor.publishStatus` is: an IO failure is a stale status file, not a crash. No-op when `--no-control`/`--once` never stood up a status path. */
function publishIntakeStatus(ctx: IntakeContext, runtime: IntakeRuntime, statusPath: string | null): void {
  if (!statusPath) return;
  try {
    writeStatusFile(statusPath, buildIntakeSnapshot(ctx, runtime, LOOP_VERSION));
  } catch (error) {
    ctx.log(`failed to publish status.json: ${String(error)}`);
  }
}

function createIntakeControlHandlers(ctx: IntakeContext, runtime: IntakeRuntime, home: string, statusPath: string | null): ControlHandlers {
  return {
    snapshot: () => buildIntakeSnapshot(ctx, runtime, LOOP_VERSION),
    pause: () => {
      runtime.runState = "paused";
      runtime.pausedAt = ctx.now().toISOString();
      runtime.emit({ event: "state", runtime: buildIntakeSnapshot(ctx, runtime, LOOP_VERSION).runtime }, ctx.now);
      publishIntakeStatus(ctx, runtime, statusPath);
    },
    resume: () => {
      runtime.runState = "running";
      runtime.pausedAt = null;
      runtime.emit({ event: "state", runtime: buildIntakeSnapshot(ctx, runtime, LOOP_VERSION).runtime }, ctx.now);
      publishIntakeStatus(ctx, runtime, statusPath);
    },
    stop: (mode) => {
      runtime.stopMode = mode;
      runtime.runState = "draining";
      runtime.emit({ event: "state", runtime: buildIntakeSnapshot(ctx, runtime, LOOP_VERSION).runtime }, ctx.now);
      publishIntakeStatus(ctx, runtime, statusPath);
      if (mode === "now") runtime.wake?.();
    },
    tick: () => {
      runtime.tickRequested = true;
      runtime.wake?.();
    },
    report: (report: AgentReport) => {
      ctx.log(
        `${report.agent} ${report.status}${report.subject ? ` ${report.subject}` : ""}: ${report.summary}`,
      );
      for (const entity of report.created) {
        ctx.log(`  + ${entity.kind} ${entity.identifier ?? entity.id} — ${entity.title}`);
      }
      runtime.emit({ event: "report", report }, ctx.now);
    },
    setMode: () => {
      throw new Error("intake has no mode — it always runs at the operator's configured autonomy; see loop.mode for a repo loop instead");
    },
    patchConfig: (patch) => {
      patchAndWriteGlobalConfig(patch, home);
      const { config } = loadGlobalConfig({ home });
      ctx.config = config;
    },
    reload: () => {
      const { config } = loadGlobalConfig({ home });
      ctx.config = config;
    },
    attachAgent: () => {
      throw new Error("foreman team dispatches only the shared triage batch; there is no per-agent pane to attach");
    },
    killAgent: () => {
      throw new Error("foreman team dispatches only the shared triage batch; there is no per-agent process to kill");
    },
  };
}

export async function runTeam(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(
    args.homePath ? { home: args.homePath } : undefined,
  );
  for (const warning of warnings) console.error(style("yellow", `[foreman-team] ${warning}`));

  // `--herdr-layout` is the operator's explicit override of `agent.herdrLayout` for this run.
  const config = {
    ...loadedConfig,
    agent: {
      ...loadedConfig.agent,
      herdrLayout: args.herdrLayout ?? loadedConfig.agent.herdrLayout,
    },
  };

  const apiKey = resolveLinearApiKey(config);

  const log = (message: string): void => {
    console.log(`${style("cyan", "[foreman-team]")} ${message}`);
  };

  /** `--verbose`: every GraphQL round-trip this process makes, success or failure. */
  const traceLinearRequest = (event: LinearRequestEvent): void => {
    if (!args.verbose) return;
    const outcome = event.ok ? style("green", "✓") : style("red", "✗");
    const retried = event.attempt > 0 ? ` (attempt ${event.attempt + 1})` : "";
    log(
      style(
        "dim",
        `  · linear ${outcome} ${event.operation}${retried}: ${Math.round(event.durationMs)}ms` +
          (event.status !== null ? ` status=${event.status}` : "") +
          (event.error ? ` — ${event.error}` : ""),
      ),
    );
  };

  // A confirm-mode loop with no operator on the other end of stdin would
  // block on the first dispatch or Linear write forever — nobody is there
  // to answer. Fail loudly at startup instead of hanging silently. `foreman
  // team` has no per-worker overrides (SPEC §3.12), so `loop.mode` alone
  // decides.
  if (config.loop.mode === "confirm" && !process.stdin.isTTY) {
    console.error(
      style(
        "red",
        "[foreman-team] loop.mode is \"confirm\" but stdin is not a TTY — there is nobody to ask. " +
          "Set loop.mode to \"yolo\" in ~/.foreman/config.json, or run this from an interactive terminal.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Team resolution mirrors `foreman repo` via the shared `resolveTeamKey`
  // (SPEC §3.11): the positional team key first, then `null` — the team
  // process has no registry entry, so `entryTeam` is always null and the
  // fallback is the sole team the credential can reach.
  const bootstrapLinear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, onRequest: traceLinearRequest });
  try {
    if (new URL(config.linear.endpoint).host !== "api.linear.app") {
      log(style("yellow", `! linear.endpoint is ${config.linear.endpoint}, not https://api.linear.app/graphql — the API key is being sent there.`));
    }
  } catch {
    log(style("yellow", `! linear.endpoint "${config.linear.endpoint}" is not a valid URL — the API key is being sent there.`));
  }
  const team = await resolveTeamKey({ linear: bootstrapLinear, flagTeam: args.team, entryTeam: null });
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team, onRequest: traceLinearRequest });

  const controlPaths = loopPaths(config, INTAKE_LOOP_ID, args.homePath ?? undefined);
  const intakeStateDir = controlPaths.dir;
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(intakeStateDir));

  // `--once` and `--no-control` start no control server, so a dispatched
  // session has nothing to report to; the env var is then simply absent.
  const controlSocket = args.once || args.noControl ? undefined : controlPaths.socket;

  const dispatcher = await resolveDispatcher(
    {
      createPrint: () => new PrintDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv], reservationsDir: controlPaths.reservations, controlSocket }),
      createHerdr: () => new HerdrDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv], reservationsDir: controlPaths.reservations, controlSocket }),
    },
    log,
  );

  const baseConfirmer: Confirmer = config.loop.mode === "confirm" ? new TtyConfirmer({ log }) : YOLO_CONFIRMER;
  // `TtyConfirmer` already logs every request it asks; only the silent
  // yolo path needs wrapping so `--verbose` still shows what was auto-approved.
  const confirmer: Confirmer =
    args.verbose && config.loop.mode !== "confirm" ? verboseConfirmer(baseConfirmer, log) : baseConfirmer;

  const lock = new SupervisorLock(lockPathFor(intakeStateDir));
  lock.acquire(process.pid, new Date());

  const statusPath = args.once || args.noControl ? null : controlPaths.status;
  const home = args.homePath ?? homedir();

  const ctx: IntakeContext = {
    config,
    linear,
    dispatcher,
    reservationsDir: controlPaths.reservations,
    bookkeeping,
    team,
    now: () => new Date(),
    log,
    confirm: (request) => confirmer.confirm(request),
    ensurePluginActive: (repoRoot) => {
      activateRepoPlugin(repoRoot, home);
    },
    verbose: args.verbose,
  };
  const runtime = new IntakeRuntime();

  /*
   * The lock is held from here on, and the control socket keeps the event
   * loop alive once it is listening — so both live inside one `finally`.
   * `controlServer.listen()` rejecting when another team process already
   * holds the socket must still release the lock, or the next run fails on
   * a lock whose owner never started. Same reasoning as `repo.ts`.
   */
  let controlServer: ControlServer | null = null;
  /*
   * Registered before the first `await` past `lock.acquire()`. The lock file
   * is what callers poll to know this process is up, so a SIGTERM can arrive
   * the instant it appears — and until these handlers exist, the default
   * disposition kills the process outright and orphans the lock. The
   * `controlServer.listen()` below is the await that made that window wide
   * enough to lose on a loaded CI runner.
   *
   * A tick already in flight (`runIntakeTick` awaiting a Linear call) must
   * finish and save its bookkeeping before the lock is released — an
   * abrupt exit mid-dispatch would spawn `/foreman-triage` without ever
   * recording it, leaking a WIP slot the same way the leak this file's
   * reconcile fix closes on the supervisor side. `draining` makes the
   * poll loop exit after its current iteration instead of waiting a full
   * `intakeInterruptibleWait`.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(style("yellow", `received ${signal}, finishing any in-flight tick before releasing the lock.`));
    runtime.stopMode = "graceful";
    runtime.runState = "draining";
    runtime.wake?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    controlServer = args.once || args.noControl
      ? null
      : new ControlServer({
          socketPath: controlPaths.socket,
          lockPath: controlPaths.lock,
          handlers: createIntakeControlHandlers(ctx, runtime, home, statusPath),
          info: {
            loopId: INTAKE_LOOP_ID,
            kind: "intake",
            pid: process.pid,
            startedAt: runtime.startedAt,
            version: LOOP_VERSION,
            protocol: 1,
          },
          log,
        });
    if (controlServer) {
      const server = controlServer;
      runtime.listeners.add((event) => {
        if (event.event === "log") server.publishLog(event.level, event.line);
        else server.broadcast(event);
      });
      await server.listen();
      log(`${style("cyan", "i")} control socket listening at ${controlPaths.socket}`);
    }

    log(style("bold", `starting: team=${team} dispatcher=${dispatcher.kind} window=${config.intake.window}`));

    if (config.loop.mode === "confirm") {
      const rule = style("yellow", "─".repeat(62));
      log(rule);
      log(style("yellow", "CONFIRM MODE — every dispatch and Linear write needs your approval."));
      log(style("yellow", "Set loop.mode to \"yolo\" in ~/.foreman/config.json to run unattended."));
      log(rule);
    }

    // Mirrors `Supervisor#runForever`: a SIGTERM (or an operator `pause`)
    // that landed during startup has already moved the state off "starting",
    // and promoting to "running" unconditionally would discard it — leaving
    // the process polling forever instead of draining.
    if (runtime.currentRunState() === "starting") runtime.runState = "running";
    if (args.once) {
      const report = await runIntakeTick(ctx);
      if (args.verbose && report.skipReason) {
        log(`skip: ${report.skipReason}`);
      }
    } else {
      while (!runtime.stopped) {
        const state = runtime.currentRunState();
        if (state === "draining") break;
        if (state === "paused") {
          await intakeInterruptibleWait(runtime, 60_000);
          continue;
        }
        runtime.tickRequested = false;
        try {
          const report = await runIntakeTick(ctx);
          runtime.lastReport = report;
          runtime.ticks += 1;
          runtime.lastTickAt = ctx.now().toISOString();
          if (args.verbose && report.skipReason) {
            log(`skip: ${report.skipReason}`);
          }
          publishIntakeStatus(ctx, runtime, statusPath);
        } catch (error) {
          // A transient Linear error (SPEC §17.5's per-worker isolation,
          // mirrored here) must not terminate an unattended process — log
          // and retry on the next cadence rather than crashing the loop.
          log(`intake tick failed: ${String(error)}`);
        }
        if (runtime.currentRunState() === "draining") break;
        await intakeInterruptibleWait(runtime, 60_000);
      }
    }
  } finally {
    runtime.runState = "stopped";
    lock.release();
    await controlServer?.close();
    confirmer.close();
  }
}

/** `sleep(ms)`, but a pending `wake` call (`tick`/`stop("now")`) resolves it early — mirrors `Supervisor#interruptibleWait`. */
async function intakeInterruptibleWait(runtime: IntakeRuntime, ms: number): Promise<void> {
  if (runtime.tickRequested) {
    runtime.tickRequested = false;
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  runtime.wake = resolve;
  const timer = setTimeout(resolve, ms);
  await Promise.race([promise]);
  clearTimeout(timer);
  runtime.wake = null;
}

// Re-exported so callers building repo-aware intake tooling need not import
// `initiativeIndex` from `@foreman/core` separately (SPEC §3.12).
export { initiativeIndex };
