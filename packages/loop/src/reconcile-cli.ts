/**
 * `foreman reconcile` — one pass over `packages/loop/src/reconcile.ts`'s
 * invariant table for a single repo instance. Setup mirrors the deleted
 * `repo.ts`'s sequence (config load, instance resolution, endpoint/team
 * validation, team-scoped client) minus everything control-plane.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  entryForCwd,
  expandHome,
  GitHubClient,
  LinearClient,
  loadGlobalConfig,
  lockTtlMs,
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
import { reconcile } from "./reconcile.ts";

interface ParsedArgs {
  repo: string | null;
  dryRun: boolean;
  mode: "confirm" | "yolo" | null;
  homePath: string | null;
  help: boolean;
}

const HELP_TEXT = `foreman reconcile — repairs Linear drift from a declarative invariant table

Usage: foreman reconcile [alias] [options]

Options:
  --dry-run              Log every invariant's fix without applying it.
  --mode <confirm|yolo>   Autonomy mode; overrides config.
  --home <path>           Home directory for ~/.foreman (test hook).
  --help, -h              Show this text.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { repo: null, dryRun: false, mode: null, homePath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--mode") {
      const value = argv[(i += 1)];
      if (value !== "confirm" && value !== "yolo") throw new ConfigError(`--mode must be "confirm" or "yolo"`, []);
      args.mode = value;
    } else if (arg === "--home") {
      args.homePath = argv[(i += 1)] ?? null;
    } else if (arg !== undefined && !arg.startsWith("-") && args.repo === null) {
      args.repo = arg;
    } else if (arg !== undefined) {
      throw new ConfigError(`Unrecognized argument: ${arg}`, ["Run `foreman reconcile --help` for the flag list."]);
    }
  }
  return args;
}

export async function runReconcile(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(args.homePath ? { home: args.homePath } : undefined);
  for (const warning of warnings) console.error(style("yellow", `[foreman-reconcile] ${warning}`));
  const config = { ...loadedConfig, loop: { ...loadedConfig.loop, mode: args.mode ?? loadedConfig.loop.mode } };

  let entry;
  try {
    entry = args.repo
      ? resolveRepoEntry(config, args.repo, args.homePath ?? undefined)
      : entryForCwd(config, process.cwd(), args.homePath ?? undefined);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(style("red", `[foreman-reconcile] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-reconcile]   - ${problem}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const log = (message: string): void => {
    console.log(`${style("cyan", `[foreman-reconcile:${entry.alias}]`)} ${message}`);
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
      console.error(style("red", `[foreman-reconcile] ${error.message}`));
      for (const problem of error.problems) console.error(style("red", `[foreman-reconcile]   - ${problem}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const linear = new LinearClient({ apiKey, endpoint: config.linear.endpoint, team, onRequest: traceLinearRequest });

  const confirmationRequired = config.loop.mode === "confirm" && !args.dryRun;
  if (confirmationRequired && !process.stdin.isTTY) {
    console.error(
      style(
        "red",
        "[foreman-reconcile] loop.mode is \"confirm\" but stdin is not a TTY — there is nobody to ask. Pass --mode yolo, or run this from an interactive terminal.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const baseConfirmer: Confirmer = confirmationRequired ? new TtyConfirmer({ log }) : YOLO_CONFIRMER;
  const confirmer = !confirmationRequired ? verboseConfirmer(baseConfirmer, log) : baseConfirmer;
  const liveDispatchIds = readLiveDispatchIds(config.loop.stateDir, entry.alias, args.homePath ?? undefined);

  const github = new GitHubClient();
  const dispatcher = await resolveDispatcher(config);
  let viewerId: string | null;
  try {
    viewerId = await linear.viewerId();
  } catch {
    viewerId = null;
  }

  try {
    const summary = await reconcile(
      {
        linear,
        github,
        entry,
        now: new Date(),
        liveDispatchIds,
        lockTtlMs: lockTtlMs(config),
        confirmer,
        viewerId,
        config,
        dispatcher,
      },
      { dryRun: args.dryRun, log },
    );

    log(`fixed=${summary.fixed} skipped=${summary.skipped}${args.dryRun ? " (dry run)" : ""}`);
    process.exitCode = 0;
  } finally {
    confirmer.close();
  }
}

/**
 * `<stateDir>/<alias>/{build,plan}.json`'s live dispatch ids — the loops
 * that actually write in-flight state. Absence — anything from a missing
 * directory to malformed JSON, e.g. because that loop has never run —
 * degrades to an empty set for that file rather than failing the reconcile run.
 */
function readLiveDispatchIds(stateDir: string, alias: string, home: string | undefined): Set<string> {
  const expanded = expandHome(stateDir, home);
  const ids = new Set<string>();
  for (const loop of ["build", "plan"]) {
    try {
      const raw = readFileSync(join(expanded, alias, `${loop}.json`), "utf8");
      const parsed = JSON.parse(raw) as { inFlight?: Record<string, { handle?: { dispatchId?: string } }> };
      for (const entry of Object.values(parsed.inFlight ?? {})) {
        if (typeof entry.handle?.dispatchId === "string") ids.add(entry.handle.dispatchId);
      }
    } catch {
      // No file for this loop: it has never run, or is mid-write. Absence is not liveness.
    }
  }
  return ids;
}
