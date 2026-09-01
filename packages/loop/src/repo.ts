/**
 * The supervisor, reached as `foreman repo` (SPEC §17.5, §17.9, §18, §3.11).
 *
 * Named for the scope it manages — one process per repo — distinct from
 * `foreman team` (`team.ts`), which manages the shared team-wide Triage
 * inbox. The supervisor mechanism itself keeps the "loop" vocabulary
 * (`Supervisor`, `LOOP_VERSION`, `loop.stage` in config) because that
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

import {
  ConfigError,
  ControlServer,
  ensureMaintenanceProjects,
  HerdrDispatcher,
  LinearClient,
  loopPaths,
  PrintDispatcher,
  repoLoopId,
  entryForCwd,
  loadGlobalConfig,
  lockTtlMs,
  resolveLinearApiKey,
  resolveRepoEntry,
  resolveTeamKey,
  style,
} from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import { createControlHandlers } from "./control.ts";
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
  dryRun: boolean;
  stage: "dry-run" | "read-only" | "full" | null;
  once: boolean;
  workerNames: string[];
  repo: string | null;
  team: string | null;
  homePath: string | null;
  noControl: boolean;
  help: boolean;
}

const HELP_TEXT = `foreman repo — Foreman per-repo supervisor (SPEC §17, §3.11)

Usage: foreman repo [alias] [options]

  [alias]                 Registry alias to run as (default: resolved from cwd).
  --dry-run              Log what each worker would dispatch; dispatch nothing.
  --stage <s>             Override loop.stage: dry-run | read-only | full.
  --once                  Run one tick of the selected workers, then exit.
  --worker <name>          Restrict to this worker; repeatable.
  --team <KEY>             Linear team key (default: the entry's team, or the sole reachable team).
  --home <path>            Home directory containing .foreman/config.json (default: real home).
  --no-control             Skip the control-plane socket/status.json; --once already implies this.
  --help                   Show this text.

Stages (loop.stage in ~/.foreman/config.json; --stage overrides):
  dry-run     Decide and log; dispatch nothing. The default.
  read-only   Dispatch agents that only comment and label.
  full        Dispatch the whole pipeline.

Triage is not part of this process — the shared Triage inbox is consumed by
\`foreman team\`, one process per team. Run \`foreman team --help\`.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    stage: null,
    once: false,
    workerNames: [],
    repo: null,
    team: null,
    homePath: null,
    noControl: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--stage": {
        if (i + 1 >= argv.length) throw new Error("missing value for --stage");
        const value = argv[++i];
        if (value !== "dry-run" && value !== "read-only" && value !== "full") {
          throw new Error(`--stage must be one of dry-run|read-only|full, got "${value ?? ""}"`);
        }
        parsed.stage = value;
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

  // `--dry-run` / `--stage` are the operator's explicit override of the
  // autonomy rung (SPEC §17.9); they win over the config file for this run.
  const config = {
    ...loadedConfig,
    loop: {
      ...loadedConfig.loop,
      stage: args.dryRun ? ("dry-run" as const) : (args.stage ?? loadedConfig.loop.stage),
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

  const apiKey = resolveLinearApiKey(config);
  // `resolveTeamKey` needs a client only to call `teams()`, which happens
  // only when neither `--team` nor the entry's `team` supply a key. `team`
  // scoping on `LinearClient` is a constructor option, not mutable state, so
  // an unscoped client resolves the team first; every other call in this
  // process then goes through a second, team-scoped client (SPEC §3.11) —
  // simpler than threading an optional team through every query site.
  const bootstrapLinear = new LinearClient({ apiKey, endpoint: config.linear.endpoint });

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
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team });

  const controlPaths = loopPaths(config, repoLoopId(entry.alias), args.homePath ?? undefined);
  const stateDir = controlPaths.dir;
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(stateDir));

  const log = (message: string): void => {
    console.log(`${style("cyan", `[foreman-repo:${entry.alias}]`)} ${message}`);
  };

  const printDispatcher = new PrintDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv] });
  const herdrDispatcher = new HerdrDispatcher(config, { scrubEnv: [config.linear.apiKeyEnv] });

  const dispatcher = await resolveDispatcher(
    {
      createPrint: () => printDispatcher,
      createHerdr: () => herdrDispatcher,
    },
    log,
  );

  const supervisor = new Supervisor({
    config,
    linear,
    dispatcher,
    printDispatcher,
    bookkeeping,
    stateDir,
    entry,
    // Preserve the raw CLI flag independently from the effective stage:
    // `setStage("full")` must never turn a process launched with
    // `--dry-run` into a mutating loop.
    dryRun: args.dryRun,
    log,
    loopId: repoLoopId(entry.alias),
    statusPath: args.once || args.noControl ? null : controlPaths.status,
    version: LOOP_VERSION,
    team,
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
          `initiatives=[${entry.initiativeIds.join(",")}] stage=${config.loop.stage} ` +
          `dispatcher=${dispatcher.kind} workers=[${selected.map((w) => w.name).join(",")}] lockTtlMs=${lockTtlMs(config)}`,
      ),
    );

    if (config.loop.stage === "dry-run") {
      const rule = style("yellow", "─".repeat(62));
      log(rule);
      log(style("yellow", "DRY RUN — stage=dry-run. No agent will be dispatched."));
      log(style("yellow", "Set loop.stage to \"read-only\" or \"full\" in ~/.foreman/config.json,"));
      log(style("yellow", "or pass --stage full, to let workers act."));
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
        dryRun: config.loop.stage !== "full",
      });
      for (const report of ensureReports) {
        log(
          report.projectId === null
            ? `${style("yellow", "!")} ensure: initiative=${report.initiativeName} (${report.initiativeId}) would create a Maintenance project (stage=${config.loop.stage})`
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
  }
}
