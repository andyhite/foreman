#!/usr/bin/env node
/**
 * `foreman` CLI entrypoint.
 *
 * Two installer commands with disjoint scope: `setup` is per-machine (Linear
 * credential, omp plugin) and `init` is per-repo (writes
 * one `config.repos` entry). They were one command with `init` as an alias,
 * which meant installing a plugin and registering a repo could not be done
 * independently — re-running to add a repo re-ran the whole installer.
 *
 * Hand-rolled argument parsing, same rationale as `foreman-loop`: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { nodeRunner } from "@foreman/core";
import { runIntake, runLoop } from "@foreman/loop";
import { runTui } from "@foreman/tui";
import { processRunner } from "./exec.ts";
import { runInit } from "./init.ts";
import { DEFAULT_GITHUB_REPO, type OmpScope } from "./plugin-commands.ts";
import { InteractivePrompter, NonInteractivePrompter, type Prompter } from "./prompt.ts";
import { resolveRepoRoot } from "./repo.ts";
import type { PluginMode } from "./wizard.ts";
import { runWizard } from "./wizard.ts";

interface ParsedArgs {
  command: "setup" | "init" | null;
  yes: boolean;
  scope: OmpScope | null;
  ompMode: PluginMode | null;
  githubRepo: string;
  repoPath: string | null;
  path: string | null;
  home: string | null;
  skipBuild: boolean;
  skipLinear: boolean;
  help: boolean;
}

const HELP_TEXT = `foreman — Foreman CLI

Usage: foreman <command> [options]

Commands:
  setup                    Per-machine install: Linear credential, omp plugin.
  init                     Per-repo: register this directory in the repos registry.
  loop                     Run the supervisor; \`foreman loop --help\` for its flags.
  intake                   Run the team-level triage process; \`foreman intake --help\` for its flags.
  tui                      Open the command center for this repo's loop and intake.

Run \`setup\` once per machine, \`init\` once per repo, then \`loop\` per repo.

Options for setup:
  --scope <user|project>     omp plugin install scope (default: prompted, "user").
  --omp <link|install|skip>  omp plugin mode; "link" symlinks this checkout ("dev mode").
  --repo-source <owner/repo>  GitHub source for "install" modes (default: ${DEFAULT_GITHUB_REPO}).
  --repo <path>              Path to the foreman checkout (default: auto-detected).
  --skip-build                Skip \`bun install && bun run build\`.

Options for init:
  --path <dir>               Directory to register (default: the current directory).

Options for both:
  -y, --yes                 Accept defaults for every prompt (non-interactive).
  --home <path>              Home directory for ~/.foreman (default: real home; test hook).
  --skip-linear               Skip Linear API access.
  --help, -h                  Show this text.
`;

function parseMode(name: string, value: string | undefined): PluginMode {
  if (value !== "link" && value !== "install" && value !== "skip") {
    throw new Error(`${name} must be one of link|install|skip, got "${value ?? ""}"`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    yes: false,
    scope: null,
    ompMode: null,
    githubRepo: DEFAULT_GITHUB_REPO,
    repoPath: null,
    path: null,
    home: null,
    skipBuild: false,
    skipLinear: false,
    help: false,
  };

  const setCommand = (command: "setup" | "init"): void => {
    if (parsed.command) {
      throw new Error(`Multiple commands supplied: "${parsed.command}" and "${command}".`);
    }
    parsed.command = command;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "setup":
      case "init":
        setCommand(arg);
        break;
      case "-y":
      case "--yes":
        parsed.yes = true;
        break;
      case "--scope": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --scope");
        const value = argv[++i];
        if (value !== "user" && value !== "project") {
          throw new Error(`--scope must be one of user|project, got "${value}"`);
        }
        parsed.scope = value;
        break;
      }
      case "--omp":
        if (argv[i + 1] === undefined) throw new Error("missing value for --omp");
        parsed.ompMode = parseMode("--omp", argv[++i]);
        break;
      case "--repo-source": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --repo-source");
        parsed.githubRepo = argv[++i] as string;
        break;
      }
      case "--repo": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --repo");
        parsed.repoPath = argv[++i] as string;
        break;
      }
      case "--path": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --path");
        parsed.path = argv[++i] as string;
        break;
      }
      case "--home": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --home");
        parsed.home = argv[++i] as string;
        break;
      }
      case "--skip-build":
        parsed.skipBuild = true;
        break;
      case "--skip-linear":
        parsed.skipLinear = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unrecognized argument: ${arg}`);
        throw new Error(`Unexpected positional argument "${arg}"; expected a command or an option value.`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  /*
   * `loop` owns every argument after it. Delegating before this CLI's own
   * parser runs is what lets the supervisor keep its flags (`--dry-run`,
   * `--stage`) without this parser having to know any of them.
   */
  if (argv[0] === "loop") {
    await runLoop(argv.slice(1));
    return;
  }

  /*
   * `intake` owns every argument after it, same rationale as `loop`: the
   * team-level process keeps its own flags (`--team`, `--once`) without this
   * parser having to know any of them.
   */
  if (argv[0] === "intake") {
    await runIntake(argv.slice(1));
    return;
  }

  /*
   * `tui` owns every argument after it, same rationale as `loop`/`intake`:
   * the command center keeps its own flags (`--repo`, `--no-start`) without
   * this parser having to know any of them.
   */
  if (argv[0] === "tui") {
    await runTui(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  if (args.help || !args.command) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const nonInteractive = args.yes || !process.stdin.isTTY;
  const prompter: Prompter = nonInteractive ? new NonInteractivePrompter() : new InteractivePrompter();
  const log = (message: string): void => console.log(message);

  try {
    /*
     * `init` deliberately skips `resolveRepoRoot`: that resolves the *foreman
     * checkout* (it looks for `packages/omp-plugin`) and would reject the
     * arbitrary product repo `init` is meant to register.
     */
    if (args.command === "init") {
      await runInit(
        {
          cwd: args.path ?? process.cwd(),
          home: args.home ?? homedir(),
          skipLinear: args.skipLinear,
        },
        { prompter, log, git: nodeRunner },
      );
      return;
    }

    const repoRoot = resolveRepoRoot(args.repoPath);
    await runWizard(
      {
        home: args.home ?? homedir(),
        repoRoot,
        githubRepo: args.githubRepo,
        scope: args.scope,
        ompMode: nonInteractive ? (args.ompMode ?? "link") : args.ompMode,
        skipBuild: args.skipBuild,
        skipLinear: args.skipLinear,
      },
      { prompter, runner: processRunner, log },
    );
  } finally {
    prompter.close();
  }
}

/*
 * Compares against the *resolved* argv[1] path: Node does not resolve
 * symlinks when populating argv[1] (Bun does), so invoking this file
 * through a symlinked `foreman` binary — the normal install shape — left
 * argv[1] pointing at the symlink while `import.meta.url` already reflects
 * the real path underneath. The mismatch silently skipped `main()` (exit 0,
 * no output) with no built-in signal, so this must resolve argv[1] first.
 */
const isMainModule = process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`;
if (isMainModule) {
  main().catch((error) => {
    console.error(`[foreman] fatal: ${String(error)}`);
    /*
     * `ConfigError` carries the individual schema problems; printing only the
     * summary leaves the operator with "invalid config" and no field name.
     */
    const { problems } = error as { problems?: unknown };
    if (Array.isArray(problems)) {
      for (const problem of problems) console.error(`[foreman]   - ${String(problem)}`);
    }
    process.exitCode = 1;
  });
}
