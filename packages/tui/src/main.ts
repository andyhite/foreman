/**
 * `foreman tui` — the command center entrypoint (SPEC §17, §3.11, §3.12).
 *
 * Same rationale as `foreman loop`/`foreman intake`: hand-rolled argument
 * parsing, because the workspace's sole runtime dependency is
 * `@sinclair/typebox`. This file only resolves the operator's intent (which
 * repo, which team, start-or-attach-only, color) and wires `Session` to
 * `TuiHost` to `TuiRuntime`; every interactive concern lives in `app.ts` and
 * the views.
 *
 * Discovery is deliberately narrowed to two loops: the TUI is a command
 * center for *this* repo, not a fleet dashboard over every registered repo,
 * so `discoverLoops` runs once at startup and everything but this repo's
 * loop and the shared `intake` loop is dropped.
 *
 * `TuiRuntime` needs a fully-formed `TuiHost` at construction, and `TuiHost`
 * needs `runtime.suspend`/`requestRender`/`quit` — a real circular
 * dependency, broken with a `let runtime` cell the host's closures capture
 * by reference. Those closures are never invoked before `runtime.start()`
 * runs, so the temporal gap is safe.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  INTAKE_LOOP_ID,
  createTheme,
  defaultTheme,
  discoverLoops,
  entryForCwd,
  loadGlobalConfig,
  repoLoopId,
  resolveRepoEntry,
  Screen,
  TuiRuntime,
} from "@foreman/core";
import type { LoopId } from "@foreman/core";
import { TuiHost } from "./app.ts";
import { Session } from "./session.ts";
import { initialState } from "./store.ts";
import { VIEW_IDS } from "./view.ts";
import { agentsView } from "./views/agents.ts";
import { blocksView } from "./views/blocks.ts";
import { logsView } from "./views/logs.ts";
import { overviewView } from "./views/overview.ts";
import { pipelineView } from "./views/pipeline.ts";
import { proposalsView } from "./views/proposals.ts";
import { settingsView } from "./views/settings.ts";

interface ParsedArgs {
  repo: string | null;
  team: string | null;
  home: string | null;
  noStart: boolean;
  noColor: boolean;
  help: boolean;
}

const HELP_TEXT = `foreman tui — command center for this repo's loop and the team intake loop

Usage: foreman tui [options]

  --repo <alias>   Registry alias to run as (default: resolved from cwd).
  --team <KEY>     Linear team key (default: the entry's team).
  --home <path>    Home directory containing .foreman/config.json (default: real home).
  --no-start       Attach only; never spawn a loop process.
  --no-color       Disable ANSI styling.
  --help           Show this text.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { repo: null, team: null, home: null, noStart: false, noColor: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo": {
        if (i + 1 >= argv.length) throw new Error("missing value for --repo");
        const value = argv[++i];
        if (!value) throw new Error("--repo requires an alias");
        parsed.repo = value;
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
        parsed.home = value;
        break;
      }
      case "--no-start":
        parsed.noStart = true;
        break;
      case "--no-color":
        parsed.noColor = true;
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

export async function runTui(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { config: loadedConfig, warnings } = loadGlobalConfig(args.home ? { home: args.home } : undefined);
  for (const warning of warnings) console.error(`[foreman-tui] ${warning}`);

  let entry;
  try {
    entry = args.repo
      ? resolveRepoEntry(loadedConfig, args.repo, args.home ?? undefined)
      : entryForCwd(loadedConfig, process.cwd(), args.home ?? undefined);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[foreman-tui] ${error.message}`);
      for (const problem of error.problems) console.error(`[foreman-tui]   - ${problem}`);
      console.error("[foreman-tui] run `foreman init` to register this repo, then retry.");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (!process.stdout.isTTY) {
    console.error("foreman tui requires a terminal");
    process.exitCode = 1;
    return;
  }

  const home = args.home ?? homedir();
  const team = args.team ?? entry.team;
  const configPath = join(home, ".foreman", "config.json");
  const loopIds: LoopId[] = [repoLoopId(entry.alias), INTAKE_LOOP_ID];

  const allHandles = await discoverLoops(loadedConfig, { home });
  const handles = allHandles.filter((handle) => loopIds.includes(handle.id));

  const theme = args.noColor ? createTheme(false) : defaultTheme;

  const state = initialState({
    config: loadedConfig,
    configPath,
    repoAlias: entry.alias,
    team,
    viewIds: VIEW_IDS,
    now: Date.now(),
  });
  state.loops = handles.map((handle) => ({
    id: handle.id,
    kind: handle.kind,
    label: handle.label,
    handle,
    snapshot: handle.status?.snapshot ?? null,
    connection: "connecting",
    error: null,
    busy: null,
  }));

  let runtime: TuiRuntime;
  const screen = new Screen();
  const session = new Session({
    config: loadedConfig,
    home,
    loopIds,
    team,
    onAction: (action) => host.dispatch(action),
    noStart: args.noStart,
  });
  const views = [overviewView, agentsView, pipelineView, blocksView, proposalsView, logsView, settingsView];
  const host = new TuiHost({
    state,
    views,
    theme,
    session,
    suspend: (fn) => runtime.suspend(fn),
    requestRender: () => runtime.requestRender(),
    quit: (code) => runtime.quit(code),
  });
  runtime = new TuiRuntime(host, { screen, theme, tickMs: 1000 });

  try {
    session.start();
    if (!args.noStart) {
      for (const id of loopIds) {
        session.ensureRunning(id).catch((error: unknown) => {
          console.error(`[foreman-tui] failed to start ${id}: ${String(error)}`);
        });
      }
    }
    await runtime.start();
  } finally {
    session.close();
  }
}
