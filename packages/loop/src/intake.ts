/**
 * `foreman intake` — the team-level triage process (SPEC §3.12).
 *
 * One process for the whole team, separate from the per-repo `foreman loop`
 * instances (§3.11): the shared Triage inbox is a single queue, and a single
 * consumer is strictly simpler than N repo-scoped loops negotiating over it.
 * It is a singleton (its own lockfile), dispatches `foreman-triage` on its
 * own window, and runs the apply pass (§7.1) on every tick so approvals are
 * picked up without a manual `/foreman-apply`.
 *
 * Hand-rolled argument parsing, same rationale as `foreman-loop`: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import {
  expandHome,
  INBOX_FILTER,
  LinearClient,
  loadGlobalConfig,
  newDispatchId,
  PROPOSALS_FILTER,
  resolveLinearApiKey,
  resolveRepoEntry,
  resolveTeamKey,
  runApplyPass,
  type Dispatcher,
  type GlobalConfig,
  type Issue,
  type LinearWriter,
  type ResolvedRepoEntry,
} from "@foreman/core";
import { HerdrDispatcher, PrintDispatcher } from "@foreman/core";
import { initiativeIndex } from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import {
  bookkeepingPathFor,
  lockPathFor,
  resolveDispatcher,
  SupervisorLock,
} from "./supervisor.ts";

interface ParsedArgs {
  team: string | null;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  configPath: string | null;
  help: boolean;
}

const HELP_TEXT = `foreman intake — team-level triage process (SPEC §3.12)

Usage: foreman intake [options]

  --team <KEY>            Linear team key. Defaults to the sole team the credential can reach.
  --once                  Run one tick, then exit.
  --dry-run               Log what would be dispatched; dispatch nothing.
  --verbose               Log every skip, not just dispatch counts.
  --home <path>           Home directory containing .foreman/config.json (default: real home).
  --help                  Show this text.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    team: null,
    once: false,
    dryRun: false,
    verbose: false,
    configPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--team": {
        const value = argv[++i];
        if (!value) throw new Error("--team requires a key");
        parsed.team = value;
        break;
      }
      case "--once":
        parsed.once = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--home": {
        const value = argv[++i];
        if (!value) throw new Error("--home requires a path");
        parsed.configPath = value;
        break;
      }
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return parsed;
}

/** `"HH:MM"` window compared against `now`'s local time-of-day, once per calendar day. */
export function pastIntakeWindow(window: string, now: Date): boolean {
  const [hourStr, minuteStr] = window.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
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
  dryRun: boolean;
}

export interface IntakeTickReport {
  ranAt: string;
  dispatched: boolean;
  skipReason: string | null;
  proposedCount: number;
  applyPassRan: boolean;
  appliedCount: number;
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
    ctx.log(skipReason);
  } else {
    const lastRunAt = ctx.bookkeeping.state.lastTriageRunAt;
    const alreadyRanToday = lastRunAt !== null && sameCalendarDay(new Date(lastRunAt), now);
    if (!pastIntakeWindow(ctx.config.intake.window, now)) {
      skipReason = `before intake.window (${ctx.config.intake.window})`;
    } else if (alreadyRanToday) {
      skipReason = "already dispatched the intake batch today";
    } else {
      const inbox = await ctx.linear.issues({ filter: INBOX_FILTER, limit: ctx.config.intake.batchSize });
      if (inbox.length === 0) {
        skipReason = "inbox empty";
      } else if (!ctx.dryRun) {
        const dispatchId = newDispatchId("foreman-triage", "batch", now);
        const scratchCwd = `${expandHome(ctx.config.loop.stateDir)}/intake/scratch`;
        try {
          const handle = await ctx.dispatcher.dispatch({
            agent: "foreman-triage",
            issueId: null,
            command: "/foreman-triage",
            dispatchId,
            cwd: scratchCwd,
          });
          void handle;
          ctx.bookkeeping.setLastTriageRun(now);
          dispatched = true;
        } catch (error) {
          skipReason = `dispatch /foreman-triage failed: ${String(error)}`;
        }
      } else {
        dispatched = true;
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
  // A single bad proposal (e.g. a Linear 4xx applying one issue) must not
  // stop this tick's bookkeeping from being saved, so failures are logged
  // and swallowed here the same way a failed triage dispatch above is.
  let appliedCount = 0;
  try {
    const applied = await runApplyPass(ctx.linear, { filter: INBOX_FILTER });
    appliedCount = applied.length;
    if (applied.length === 0) {
      ctx.log("apply pass: no approvals pending.");
    } else {
      const identifiers = applied.map((proposal) => proposal.identifier).join(", ");
      ctx.log(`apply pass: applied ${applied.length} approved proposal(s) — ${identifiers}.`);
    }
  } catch (error) {
    ctx.log(`apply pass failed: ${String(error)}`);
  }

  ctx.bookkeeping.save();

  return {
    ranAt: now.toISOString(),
    dispatched,
    skipReason,
    proposedCount,
    applyPassRan: true,
    appliedCount,
  };
}

export async function runIntake(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(
    args.configPath ? { home: args.configPath } : undefined,
  );
  for (const warning of warnings) console.error(`[foreman-intake] ${warning}`);

  const config = {
    ...loadedConfig,
    loop: {
      ...loadedConfig.loop,
      stage: args.dryRun ? ("dry-run" as const) : loadedConfig.loop.stage,
    },
  };

  const apiKey = resolveLinearApiKey(config);

  const log = (message: string): void => {
    console.log(`[foreman-intake] ${message}`);
  };

  // Team resolution mirrors `foreman loop` via the shared `resolveTeamKey`
  // (SPEC §3.11): `--team` flag first, then the entry's team — but intake
  // has no registry entry, so `entryTeam` is always null and the fallback is
  // the sole team the credential can reach.
  const bootstrapLinear = new LinearClient({ apiKey, endpoint: config.linear.endpoint });
  const team = await resolveTeamKey({ linear: bootstrapLinear, flagTeam: args.team, entryTeam: null });
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team });

  const intakeStateDir = `${expandHome(config.loop.stateDir)}/intake`;
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(intakeStateDir));

  const dispatcher = await resolveDispatcher(
    config,
    {
      createPrint: () => new PrintDispatcher(config),
      createHerdr: () => new HerdrDispatcher(config),
    },
    log,
  );

  const lock = new SupervisorLock(lockPathFor(intakeStateDir));
  lock.acquire(process.pid, new Date());

  const shutdown = (signal: string): void => {
    log(`received ${signal}, releasing lock and exiting.`);
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const ctx: IntakeContext = {
    config,
    linear,
    dispatcher,
    bookkeeping,
    team,
    now: () => new Date(),
    log,
    dryRun: args.dryRun,
  };

  log(`starting: team=${team} dispatcher=${dispatcher.kind} window=${config.intake.window}`);

  try {
    if (args.once) {
      const report = await runIntakeTick(ctx);
      if (args.verbose && report.skipReason) {
        log(`skip: ${report.skipReason}`);
      }
    } else {
      for (;;) {
        const report = await runIntakeTick(ctx);
        if (args.verbose && report.skipReason) {
          log(`skip: ${report.skipReason}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
      }
    }
  } finally {
    lock.release();
  }
}

// Re-exported so callers building repo-aware intake tooling need not import
// `initiativeIndex` from `@foreman/core` separately (SPEC §3.12).
export { initiativeIndex };
