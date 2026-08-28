/**
 * The supervisor, reached as `foreman loop` (SPEC §17.5, §17.9, §18).
 *
 * SPEC §17 names a `foreman-loop` binary; it was written before a `foreman`
 * CLI existed, and two binaries split by a hyphen is not a surface (see
 * docs/VERIFIED.md). The log prefix and the herdr pane label keep the
 * `foreman-loop` spelling, because those name the long-lived process, not the
 * command an operator types.
 *
 * Hand-rolled argument parsing — the workspace's sole runtime dependency is
 * `@sinclair/typebox` (config validation), so no CLI framework here.
 */

import { LinearClient, loadGlobalConfig, lockTtlMs, resolveLinearApiKey } from "@foreman/core";
import { HerdrDispatcher, PrintDispatcher } from "@foreman/core";
import { Bookkeeping } from "./bookkeeping.ts";
import { Supervisor, bookkeepingPathFor, resolveDispatcher } from "./supervisor.ts";
import { triageWorker } from "./workers/triage.ts";
import { refineWorker } from "./workers/refine.ts";
import { implementWorker } from "./workers/implement.ts";
import { reviewWorker } from "./workers/review.ts";
import { reaperWorker } from "./workers/reaper.ts";
import { mergeDetectWorker } from "./workers/merge-detect.ts";
import type { Worker } from "./workers/types.ts";
import { expandHome } from "@foreman/core";

interface ParsedArgs {
  dryRun: boolean;
  stage: "dry-run" | "read-only" | "full" | null;
  once: boolean;
  workerNames: string[];
  configPath: string | null;
  verbose: boolean;
  help: boolean;
}

const HELP_TEXT = `foreman loop — Foreman supervisor (SPEC §17)

Usage: foreman loop [options]

  --dry-run              Log what each worker would dispatch; dispatch nothing.
  --stage <s>             Override loop.stage: dry-run | read-only | full.
  --once                  Run one tick of the selected workers, then exit.
  --worker <name>          Restrict to this worker; repeatable.
  --config <path>          Home directory containing .foreman/config.json (default: real home).
  --verbose                Log every skip, not just dispatch counts.
  --help                   Show this text.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    stage: null,
    once: false,
    workerNames: [],
    configPath: null,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--stage": {
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
        const value = argv[++i];
        if (!value) throw new Error("--worker requires a name");
        parsed.workerNames.push(value);
        break;
      }
      case "--config": {
        const value = argv[++i];
        if (!value) throw new Error("--config requires a path");
        parsed.configPath = value;
        break;
      }
      case "--verbose":
        parsed.verbose = true;
        break;
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

export async function runLoop(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(
    args.configPath ? { home: args.configPath } : undefined,
  );
  for (const warning of warnings) console.error(`[foreman-loop] ${warning}`);

  // `--dry-run` / `--stage` are the operator's explicit override of the
  // autonomy rung (SPEC §17.9); they win over the config file for this run.
  const config = {
    ...loadedConfig,
    loop: {
      ...loadedConfig.loop,
      stage: args.dryRun ? ("dry-run" as const) : (args.stage ?? loadedConfig.loop.stage),
    },
  };

  const apiKey = resolveLinearApiKey(config);
  const linear = new LinearClient({
    apiKey,
    endpoint: config.linear.endpoint,
    teamKeys: config.linear.teamKeys,
  });

  const stateDir = expandHome(config.loop.stateDir);
  const bookkeeping = Bookkeeping.load(bookkeepingPathFor(stateDir));

  const log = (message: string): void => {
    console.log(`[foreman-loop] ${message}`);
  };

  const dispatcher = await resolveDispatcher(
    config,
    {
      createPrint: () => new PrintDispatcher(config),
      createHerdr: () => new HerdrDispatcher(config),
    },
    log,
  );

  const supervisor = new Supervisor({
    config,
    linear,
    dispatcher,
    bookkeeping,
    stateDir,
    dryRun: args.dryRun || config.loop.stage === "dry-run",
    log,
  });

  supervisor.acquireLock();

  const shutdown = (signal: string): void => {
    log(`received ${signal}, releasing lock and exiting.`);
    supervisor.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await supervisor.reconcile();

    const allWorkers: Worker[] = [
      reaperWorker,
      triageWorker,
      refineWorker,
      implementWorker,
      reviewWorker,
      mergeDetectWorker,
    ];
    const selected = args.workerNames.length > 0
      ? allWorkers.filter((worker) => args.workerNames.includes(worker.name))
      : allWorkers;

    log(
      `starting: stage=${config.loop.stage} dispatcher=${dispatcher.kind} ` +
        `workers=[${selected.map((w) => w.name).join(",")}] lockTtlMs=${lockTtlMs(config)}`,
    );

    if (args.once) {
      const reports = await supervisor.runTick(selected);
      if (args.verbose) {
        for (const report of reports) {
          for (const skip of report.skipped) {
            log(`  skip ${report.worker} ${skip.issueId ?? "(batch)"}: ${skip.code} — ${skip.message}`);
          }
        }
      }
    } else {
      await supervisor.runForever(selected, { pollMs: 30_000 });
    }
  } finally {
    supervisor.stop();
  }
}
