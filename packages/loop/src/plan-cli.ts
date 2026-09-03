/**
 * `foreman plan` — the plan loop's entrypoint (triage/plan/refine). Setup
 * mirrors `reconcile-cli.ts`'s sequence (config load, entry resolution,
 * team-scoped Linear client, confirmer) plus a dispatcher, an
 * `InflightStore`, and the loop's own singleton process lock.
 */

import {
  ConfigError,
  entryForCwd,
  expandHome,
  GitHubClient,
  LinearClient,
  loadGlobalConfig,
  resolveLinearApiKey,
  resolveRepoEntry,
  resolveTeamKey,
  style,
  TtyConfirmer,
  verboseConfirmer,
  YOLO_CONFIRMER,
  type Confirmer,
  type LinearRequestEvent,
} from "@foreman/core";
import { resolveDispatcher } from "./dispatch/resolve.ts";
import { runLoop, type LoopContext } from "./engine.ts";
import { InflightStore } from "./inflight.ts";
import { PLAN_LOOP } from "./loops/plan.ts";
import { ProcessLock, ProcessLockHeldError } from "./process-lock.ts";

interface ParsedArgs {
  repo: string | null;
  once: boolean;
  mode: "confirm" | "yolo" | null;
  dispatcherKind: "auto" | "print" | "herdr" | null;
  pollSeconds: number | null;
  verbose: boolean;
  homePath: string | null;
  help: boolean;
}

const HELP_TEXT = `foreman plan — triage, plan, refine

Usage: foreman plan [alias] [options]

Options:
  --once                            Run one poll, dispatch what's eligible, wait for it, then exit.
  --mode <confirm|yolo>              Autonomy mode; overrides config.
  --dispatcher <auto|print|herdr>    Which dispatcher to use; overrides config.
  --poll <seconds>                   Poll interval; overrides config.
  --verbose                          Log every confirmation decision, even under yolo.
  --home <path>                      Home directory for ~/.foreman (test hook).
  --help, -h                         Show this text.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    repo: null,
    once: false,
    mode: null,
    dispatcherKind: null,
    pollSeconds: null,
    verbose: false,
    homePath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--mode") {
      const value = argv[(i += 1)];
      if (value !== "confirm" && value !== "yolo") throw new ConfigError(`--mode must be "confirm" or "yolo"`, []);
      args.mode = value;
    } else if (arg === "--dispatcher") {
      const value = argv[(i += 1)];
      if (value !== "auto" && value !== "print" && value !== "herdr") {
        throw new ConfigError(`--dispatcher must be "auto", "print", or "herdr"`, []);
      }
      args.dispatcherKind = value;
    } else if (arg === "--poll") {
      const value = Number(argv[(i += 1)]);
      if (!Number.isFinite(value) || value < 1) {
        throw new ConfigError(`--poll must be a positive number of seconds`, []);
      }
      args.pollSeconds = value;
    } else if (arg === "--home") {
      args.homePath = argv[(i += 1)] ?? null;
    } else if (arg && !arg.startsWith("-") && args.repo === null) {
      args.repo = arg;
    }
  }
  return args;
}

export async function runPlan(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(args.homePath ? { home: args.homePath } : undefined);
  for (const warning of warnings) console.error(style("yellow", `[foreman-plan] ${warning}`));
  const config = {
    ...loadedConfig,
    loop: {
      ...loadedConfig.loop,
      mode: args.mode ?? loadedConfig.loop.mode,
      pollSeconds: args.pollSeconds ?? loadedConfig.loop.pollSeconds,
    },
    agent: { ...loadedConfig.agent, dispatcher: args.dispatcherKind ?? loadedConfig.agent.dispatcher },
  };

  let entry;
  try {
    entry = args.repo
      ? resolveRepoEntry(config, args.repo, args.homePath ?? undefined)
      : entryForCwd(config, process.cwd(), args.homePath ?? undefined);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(style("red", `[foreman-plan] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-plan]   - ${problem}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const log = (message: string): void => {
    console.log(`${style("cyan", `[foreman-plan:${entry.alias}]`)} ${message}`);
  };

  const traceLinearRequest = (event: LinearRequestEvent): void => {
    const outcome = event.ok ? style("green", "✓") : style("red", "✗");
    log(style("dim", `  · linear ${outcome} ${event.operation}: ${Math.round(event.durationMs)}ms`));
  };

  const apiKey = resolveLinearApiKey(config);
  const bootstrapLinear = new LinearClient({ apiKey, endpoint: config.linear.endpoint });
  let endpointHost: string;
  try {
    endpointHost = new URL(config.linear.endpoint).host;
  } catch {
    endpointHost = "";
  }
  if (endpointHost !== "api.linear.app" && endpointHost !== "" && !config.linear.allowCustomEndpoint) {
    throw new ConfigError(
      `linear.endpoint is ${config.linear.endpoint}, not https://api.linear.app/graphql — the API key would be sent there.`,
      ["Set linear.allowCustomEndpoint: true in ~/.foreman/config.json if this is deliberate."],
    );
  }

  let team: string;
  try {
    team = await resolveTeamKey({ linear: bootstrapLinear, flagTeam: null, entryTeam: entry.team });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(style("red", `[foreman-plan] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-plan]   - ${problem}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team, onRequest: traceLinearRequest });

  const confirmationRequired = config.loop.mode === "confirm";
  if (confirmationRequired && !args.once && !process.stdin.isTTY) {
    console.error(
      style(
        "red",
        `[foreman-plan] loop.mode is "confirm" but stdin is not a TTY — there is nobody to ask. Pass --mode yolo, or run this from an interactive terminal.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const baseConfirmer: Confirmer = confirmationRequired ? new TtyConfirmer({ log }) : YOLO_CONFIRMER;
  const confirmer = args.verbose && !confirmationRequired ? verboseConfirmer(baseConfirmer, log) : baseConfirmer;

  const stateDir = expandHome(config.loop.stateDir, args.homePath ?? undefined);
  const github = new GitHubClient();
  const dispatcher = await resolveDispatcher(config);

  const inflightPath = `${stateDir}/${entry.alias}/plan.json`;
  const state = await InflightStore.load(inflightPath, dispatcher);

  const lock = new ProcessLock(`${stateDir}/${entry.alias}/plan.lock`);
  try {
    lock.acquire(process.pid, new Date());
  } catch (error) {
    if (error instanceof ProcessLockHeldError) {
      console.error(style("red", `[foreman-plan] ${error.message}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    const ctx: LoopContext = { linear, github, entry, config, now: () => new Date() };
    const loop = { ...PLAN_LOOP, concurrency: config.loop.concurrency.plan };
    await runLoop(loop, ctx, {
      once: args.once,
      dispatcher,
      confirmer,
      state,
      log,
      pollMs: config.loop.pollSeconds * 1000,
    });
  } finally {
    lock.release();
    confirmer.close();
  }
}
