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

import { homedir } from "node:os";
import {
  ControlServer,
  DISPATCH_COMMAND,
  HerdrDispatcher,
  INBOX_FILTER,
  INTAKE_LOOP_ID,
  LinearClient,
  PrintDispatcher,
  PROPOSALS_FILTER,
  emptyBoardCounts,
  expandHome,
  findApprovedUnapplied,
  initiativeIndex,
  loadGlobalConfig,
  loopPaths,
  newDispatchId,
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
  help: boolean;
}

const HELP_TEXT = `foreman team — team-level triage process (SPEC §3.12)

Usage: foreman team [key] [options]

  [key]                   Linear team key. Defaults to the sole team the credential can reach.
  --once                  Run one tick, then exit.
  --verbose               Log skip reasons, Linear request tracing, auto-approved actions, and full error stacks.
  --home <path>           Home directory containing .foreman/config.json (default: real home).
  --no-control            Skip the control-plane socket/status.json; --once already implies this.
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

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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

export interface IntakeContext {
  config: GlobalConfig;
  linear: LinearWriter;
  dispatcher: Dispatcher;
  bookkeeping: Bookkeeping;
  team: string;
  now: () => Date;
  log: (message: string) => void;
  confirm(request: ConfirmRequest): Promise<boolean>;
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
    const alreadyRanToday = lastRunAt !== null && sameCalendarDay(new Date(lastRunAt), now);
    if (!pastIntakeWindow(ctx.config.intake.window, now, ctx.config.intake.timezone)) {
      skipReason = `before intake.window (${ctx.config.intake.window})`;
    } else if (alreadyRanToday) {
      skipReason = "already dispatched the intake batch today";
    } else {
      const inbox = await ctx.linear.issues({ filter: INBOX_FILTER, limit: ctx.config.intake.batchSize });
      if (inbox.length === 0) {
        skipReason = "inbox empty";
      } else {
        const dispatchId = newDispatchId("foreman-triage", "batch", now);
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
            const handle = await ctx.dispatcher.dispatch({
              agent: "foreman-triage",
              issueId: null,
              // The triage agent holds no config-reading tool, so the dispatch
              // command is the only channel that carries `intake.staleLowDays`
              // (SPEC §3.10, §3.12) — the same channel `intake.batchSize`
              // already uses to size `identifiers` above.
              command,
              dispatchId,
              cwd: scratchCwd,
              worktree: null,
            });
            void handle;
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
    const candidates = await findApprovedUnapplied(ctx.linear, { filter: INBOX_FILTER });
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
        const { applied, failures } = await runApplyPass(ctx.linear, { filter: INBOX_FILTER });
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

  const config = loadedConfig;

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
  const team = await resolveTeamKey({ linear: bootstrapLinear, flagTeam: args.team, entryTeam: null });
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team, onRequest: traceLinearRequest });

  const controlPaths = loopPaths(config, INTAKE_LOOP_ID, args.homePath ?? undefined);
  const intakeStateDir = controlPaths.dir;
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(intakeStateDir));

  const dispatcher = await resolveDispatcher(
    {
      createPrint: () => new PrintDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv] }),
      createHerdr: () => new HerdrDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv] }),
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

  const ctx: IntakeContext = {
    config,
    linear,
    dispatcher,
    bookkeeping,
    team,
    now: () => new Date(),
    log,
    confirm: (request) => confirmer.confirm(request),
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
  try {
    const home = args.homePath ?? homedir();
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

    // A tick already in flight (`runIntakeTick` awaiting a Linear call) must
    // finish and save its bookkeeping before the lock is released — an
    // abrupt exit mid-dispatch would spawn `/foreman-triage` without ever
    // recording it, leaking a WIP slot the same way the leak this file's
    // reconcile fix closes on the supervisor side. `draining` makes the
    // poll loop exit after its current iteration instead of waiting a full
    // `intakeInterruptibleWait`.
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(style("yellow", `received ${signal}, finishing any in-flight tick before releasing the lock.`));
      runtime.stopMode = "graceful";
      runtime.runState = "draining";
      runtime.wake?.();
      if (args.once) {
        lock.release();
        void (controlServer?.close() ?? Promise.resolve()).finally(() => process.exit(0));
      }
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    log(style("bold", `starting: team=${team} dispatcher=${dispatcher.kind} window=${config.intake.window}`));

    if (config.loop.mode === "confirm") {
      const rule = style("yellow", "─".repeat(62));
      log(rule);
      log(style("yellow", "CONFIRM MODE — every dispatch and Linear write needs your approval."));
      log(style("yellow", "Set loop.mode to \"yolo\" in ~/.foreman/config.json to run unattended."));
      log(rule);
    }

    runtime.runState = "running";
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
