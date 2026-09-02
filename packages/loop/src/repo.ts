/**
 * The supervisor, reached as `foreman repo` (SPEC §17.5, §17.9, §18, §3.11).
 *
 * Named for the scope it manages — one process per repo — distinct from
 * `foreman team` (`team.ts`), which manages the shared team-wide Triage
 * inbox. The supervisor mechanism itself keeps the "loop" vocabulary
 * (`Supervisor`, `LOOP_VERSION`, `loop.mode` in config) because that
 * describes how it runs, not what it's scoped to.
 *
 * Hand-rolled argument parsing — the workspace's sole runtime dependency is
 * `@sinclair/typebox` (config validation), so no CLI framework here.
 *
 * One process per repo (SPEC §3.11): the instance's registry entry resolves
 * either from a positional alias argument or by matching `process.cwd()`
 * against the registry, and the team resolves from `--team`, the entry's
 * `team`, or the sole team the credential can reach. Triage is not part of
 * this process — `foreman team` (`team.ts`) owns the shared Triage inbox
 * (SPEC §3.12).
 */

import { HerdrDispatcher, PrintDispatcher } from "./dispatch/index.ts";
import {
  ConfigError,
  ControlServer,
  ensureMaintenanceProjects,
  LinearClient,
  loopPaths,
  repoLoopId,
  entryForCwd,
  loadGlobalConfig,
  lockTtlMs,
  resolveLinearApiKey,
  resolveRepoEntry,
  resolveTeamKey,
  style,
  TtyConfirmer,
  verboseConfirmer,
  YOLO_CONFIRMER,
  type LinearRequestEvent,
  type LoopMode,
} from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import { createControlHandlers } from "./control.ts";
import { confirmationRequired } from "./routing.ts";
import { Supervisor, bookkeepingPathFor, resolveDispatcher } from "./supervisor.ts";
import { refineWorker } from "./workers/refine.ts";
import { planWorker } from "./workers/plan.ts";
import { implementWorker } from "./workers/implement.ts";
import { reviewWorker } from "./workers/review.ts";
import { reaperWorker } from "./workers/reaper.ts";
import { mergeDetectWorker } from "./workers/merge-detect.ts";
import { projectStatusWorker } from "./workers/project-status.ts";
import type { Worker } from "./workers/types.ts";
import { LOOP_VERSION } from "./version.ts";

interface ParsedArgs {
  mode: LoopMode | null;
  once: boolean;
  workerNames: string[];
  repo: string | null;
  team: string | null;
  homePath: string | null;
  noControl: boolean;
  verbose: boolean;
  herdrLayout: "tab" | "pane" | null;
  help: boolean;
}

const HELP_TEXT = `foreman repo — Foreman per-repo supervisor (SPEC §17, §3.11)

Usage: foreman repo [alias] [options]

  [alias]                 Registry alias to run as (default: resolved from cwd).
  --mode <m>              Override loop.mode: confirm | yolo.
  --once                  Run one tick of the selected workers, then exit.
  --worker <name>          Restrict to this worker; repeatable.
  --team <KEY>             Linear team key (default: the entry's team, or the sole reachable team).
  --home <path>            Home directory containing .foreman/config.json (default: real home).
  --no-control             Skip the control-plane socket/status.json; --once already implies this.
  --herdr-layout <l>       Override agent.herdrLayout: tab | pane.
  --verbose               Log Linear request tracing, dispatch handles, tick timing, and full error stacks.
  --help                   Show this text.

Modes (loop.mode in ~/.foreman/config.json; --mode overrides):
  confirm     Ask before every dispatch and every Linear write. The default.
  yolo        Act without asking.

Triage is not part of this process — the shared Triage inbox is consumed by
\`foreman team\`, one process per team. Run \`foreman team --help\`.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: null,
    once: false,
    workerNames: [],
    repo: null,
    team: null,
    homePath: null,
    noControl: false,
    verbose: false,
    herdrLayout: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        if (i + 1 >= argv.length) throw new Error("missing value for --mode");
        const value = argv[++i];
        if (value !== "confirm" && value !== "yolo") {
          throw new Error(`--mode must be one of confirm|yolo, got "${value ?? ""}"`);
        }
        parsed.mode = value;
        break;
      }
      case "--once":
        parsed.once = true;
        break;
      case "--worker": {
        if (i + 1 >= argv.length) throw new Error("missing value for --worker");
        const value = argv[++i];
        if (!value) throw new Error("--worker requires a name");
        parsed.workerNames.push(value);
        break;
      }
      case "--team": {
        if (i + 1 >= argv.length) throw new Error("missing value for --team");
        const value = argv[++i];
        if (!value) throw new Error("--team requires a key");
        parsed.team = value;
        break;
      }
      case "--home": {
        if (i + 1 >= argv.length) throw new Error("missing value for --home");
        const value = argv[++i];
        if (!value) throw new Error("--home requires a path");
        parsed.homePath = value;
        break;
      }
      case "--no-control":
        parsed.noControl = true;
        break;
      case "--verbose":
        parsed.verbose = true;
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
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default: {
        if (!arg || arg.startsWith("-")) throw new Error(`Unrecognized argument: ${arg ?? ""}`);
        if (parsed.repo !== null) throw new Error(`Unexpected positional argument: ${arg}`);
        parsed.repo = arg;
        break;
      }
    }
  }
  return parsed;
}

export async function runRepo(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(
    args.homePath ? { home: args.homePath } : undefined,
  );
  for (const warning of warnings) console.error(style("yellow", `[foreman-repo] ${warning}`));

  // `--mode` is the operator's explicit override of the autonomy mode
  // (SPEC §17.9); it wins over the config file for this run. `--herdr-layout`
  // is the same kind of override for `agent.herdrLayout`.
  const config = {
    ...loadedConfig,
    loop: {
      ...loadedConfig.loop,
      mode: args.mode ?? loadedConfig.loop.mode,
    },
    agent: {
      ...loadedConfig.agent,
      herdrLayout: args.herdrLayout ?? loadedConfig.agent.herdrLayout,
    },
  };

  // Instance resolution (SPEC §3.11): a positional alias argument names a
  // registry alias directly; otherwise the entry is inferred from cwd. A
  // `ConfigError` here must exit loudly before anything is dispatched — an
  // unresolvable instance has nothing safe to do.
  let entry;
  try {
    entry = args.repo
      ? resolveRepoEntry(config, args.repo, args.homePath ?? undefined)
      : entryForCwd(config, process.cwd(), args.homePath ?? undefined);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(style("red", `[foreman-repo] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-repo]   - ${problem}`));
      console.error(style("red", "[foreman-repo] run `foreman init` to register this repo, then retry."));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const log = (message: string): void => {
    console.log(`${style("cyan", `[foreman-repo:${entry.alias}]`)} ${message}`);
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

  const apiKey = resolveLinearApiKey(config);
  // `resolveTeamKey` needs a client only to call `teams()`, which happens
  // only when neither `--team` nor the entry's `team` supply a key. `team`
  // scoping on `LinearClient` is a constructor option, not mutable state, so
  // an unscoped client resolves the team first; every other call in this
  // process then goes through a second, team-scoped client (SPEC §3.11) —
  // simpler than threading an optional team through every query site.
  const bootstrapLinear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, onRequest: traceLinearRequest });

  let team: string;
  try {
    team = await resolveTeamKey({ linear: bootstrapLinear, flagTeam: args.team, entryTeam: entry.team });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(style("red", `[foreman-repo] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-repo]   - ${problem}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team, onRequest: traceLinearRequest });

  const controlPaths = loopPaths(config, repoLoopId(entry.alias), args.homePath ?? undefined);
  const stateDir = controlPaths.dir;
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(stateDir));

  // A confirm-mode loop with no operator on the other end of stdin would
  // block on the first dispatch or Linear write forever — nobody is there
  // to answer. Fail loudly at startup instead of hanging silently.
  if (confirmationRequired(config.loop) && !process.stdin.isTTY) {
    console.error(
      style(
        "red",
        "[foreman-repo] loop.mode is \"confirm\" (or a worker override is) but stdin is not a TTY — " +
          "there is nobody to ask. Pass --mode yolo, or run this from an interactive terminal.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  const printDispatcher = new PrintDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv], reservationsDir: controlPaths.reservations });
  const herdrDispatcher = new HerdrDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv], reservationsDir: controlPaths.reservations });

  const dispatcher = await resolveDispatcher(
    {
      createPrint: () => printDispatcher,
      createHerdr: () => herdrDispatcher,
    },
    log,
  );

  const baseConfirmer = confirmationRequired(config.loop) ? new TtyConfirmer({ log }) : YOLO_CONFIRMER;
  // `TtyConfirmer` already logs every request it asks; only the silent
  // yolo path needs wrapping so `--verbose` still shows what was auto-approved.
  const confirmer = args.verbose && !confirmationRequired(config.loop) ? verboseConfirmer(baseConfirmer, log) : baseConfirmer;

  const supervisor = new Supervisor({
    config,
    linear,
    dispatcher,
    printDispatcher,
    bookkeeping,
    stateDir,
    reservationsDir: controlPaths.reservations,
    entry,
    confirmer,
    log,
    loopId: repoLoopId(entry.alias),
    statusPath: args.once || args.noControl ? null : controlPaths.status,
    version: LOOP_VERSION,
    team,
    verbose: args.verbose,
  });

  supervisor.acquireLock();

  /*
   * Everything past `acquireLock` runs holding the singleton lock and, once
   * the server is listening, an open unix socket — so it all has to sit
   * inside one `finally`.
   *
   * The ensure pass below used to `return` past the cleanup on a `ConfigError`
   * (a 401 from `linear.teams()` is the common case). The listening socket
   * then kept the event loop alive with `process.exitCode` set but nothing
   * left to run: the loop became a zombie holding `loop.lock`, and every
   * later `foreman repo` in that repo failed with `LoopLockHeldError`.
   */
  let controlServer: ControlServer | null = null;
  /*
   * Registered before the first `await` past `acquireLock()`. The lock file
   * is what callers poll to know this process is up, so a SIGTERM can arrive
   * the instant it appears — and until these handlers exist, the default
   * disposition kills the process outright and orphans the lock. The
   * `controlServer.listen()` below is the await that widens that window.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(style("yellow", `received ${signal}, finishing any in-flight tick before releasing the lock.`));
    supervisor.requestStop("graceful");
    // When polling, `runForever` reaches its own cleanup immediately after
    // the active tick. `--once` has no poll loop to observe the request.
    if (args.once) {
      supervisor.stop();
      void (controlServer?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    // The control server has nothing to supervise once `--once` exits right
    // after its single tick, and an operator can opt out entirely with
    // `--no-control` (SPEC §17).
    controlServer = args.once || args.noControl
      ? null
      : new ControlServer({
          socketPath: controlPaths.socket,
          lockPath: controlPaths.lock,
          handlers: createControlHandlers({ supervisor }),
          info: {
            loopId: repoLoopId(entry.alias),
            kind: "repo",
            pid: process.pid,
            startedAt: new Date().toISOString(),
            version: LOOP_VERSION,
            protocol: 1,
          },
          log,
        });
    if (controlServer) {
      const server = controlServer;
      supervisor.onEvent((event) => {
        if (event.event === "log") server.publishLog(event.level, event.line);
        else server.broadcast(event);
      });
      await server.listen();
      log(`${style("cyan", "i")} control socket listening at ${controlPaths.socket}`);
    }

    const cadenceMs = config.loop.cadenceMinutes * 60_000;
    const allWorkers: Worker[] = [
      reaperWorker,
      planWorker,
      refineWorker,
      implementWorker,
      reviewWorker,
      mergeDetectWorker,
      projectStatusWorker,
    ].map((worker) => ({ ...worker, cadenceMs }));
    const selected = args.workerNames.length > 0
      ? allWorkers.filter((worker) => args.workerNames.includes(worker.name))
      : allWorkers;

    /*
     * Before `reconcile()`, which is the first Linear call. An operator debugging
     * a 401 needs to know which instance, repo, and team they just started; a
     * raw API error with no identity above it is unreadable once several
     * instances are running (SPEC §3.11).
     */
    log(
      style(
        "bold",
        `starting: repo=${entry.alias} path=${entry.repoPath} team=${team} ` +
          `initiatives=[${entry.initiativeIds.join(",")}] mode=${config.loop.mode} ` +
          `dispatcher=${dispatcher.kind} workers=[${selected.map((w) => w.name).join(",")}] lockTtlMs=${lockTtlMs(config)}`,
      ),
    );

    if (confirmationRequired(config.loop)) {
      const rule = style("yellow", "─".repeat(62));
      log(rule);
      log(style("yellow", "CONFIRM MODE — every dispatch and Linear write needs your approval."));
      log(style("yellow", "Set loop.mode to \"yolo\" in ~/.foreman/config.json, or pass --mode yolo, to run unattended."));
      log(rule);
    }

    // Ensure pass (SPEC §3.11): every bound initiative must exist and have its
    // standing Maintenance project before reconcile's first board read, so
    // refine/implement never race a missing project. `team` here is a team
    // *key*; `createProject` needs the UUID, so resolve it the same way the
    // rest of this file resolves other Linear ids — via `teams()`.
    try {
      const teams = await linear.teams();
      const teamRef = teams.find((candidate) => candidate.key === team);
      if (!teamRef) {
        throw new ConfigError(`Team "${team}" was not found for the ensure pass`, [
          "the resolved team key no longer matches a team the credential can reach",
        ]);
      }
      const ensureReports = await ensureMaintenanceProjects(linear, {
        initiativeIds: entry.initiativeIds,
        teamId: teamRef.id,
        confirmer,
      });
      for (const report of ensureReports) {
        log(
          report.projectId === null
            ? `${style("yellow", "!")} ensure: initiative=${report.initiativeName} (${report.initiativeId}) Maintenance project not created (declined)`
            : `${style("green", "✓")} ensure: initiative=${report.initiativeName} (${report.initiativeId}) ` +
                `Maintenance project=${report.projectId} ${report.created ? "created" : "already present"}`,
        );
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(style("red", `[foreman-repo] ${error.message}`));
        for (const problem of error.problems) console.error(style("red", `[foreman-repo]   - ${problem}`));
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    await supervisor.reconcile();

    if (args.once) {
      await supervisor.runTick(selected);
    } else {
      await supervisor.runForever(selected, { pollMs: 30_000 });
    }
  } finally {
    supervisor.stop();
    await controlServer?.close();
    confirmer.close();
  }
}
