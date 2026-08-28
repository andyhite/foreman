#!/usr/bin/env node
/**
 * `foreman` CLI entrypoint. One command today: `setup` (alias `init`) —
 * writes `~/.foreman/config.json` and installs the omp plugin, plus the
 * optional herdr board.
 *
 * Hand-rolled argument parsing, same rationale as `foreman-loop`: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import { homedir } from "node:os";
import { runLoop } from "@foreman/loop";
import { processRunner } from "./exec.ts";
import { DEFAULT_GITHUB_REPO, type OmpScope } from "./plugin-commands.ts";
import { InteractivePrompter, NonInteractivePrompter, type Prompter } from "./prompt.ts";
import { resolveRepoRoot } from "./repo.ts";
import type { PluginMode } from "./wizard.ts";
import { runWizard } from "./wizard.ts";

interface ParsedArgs {
  command: "setup" | "help" | null;
  yes: boolean;
  scope: OmpScope | null;
  ompMode: PluginMode | null;
  herdrMode: PluginMode | null;
  githubRepo: string;
  repoPath: string | null;
  home: string | null;
  skipBuild: boolean;
  skipLinear: boolean;
  help: boolean;
}

const HELP_TEXT = `foreman — Foreman CLI

Usage: foreman <command> [options]

Commands:
  setup, init              Interactive installer: config file, omp plugin, herdr board.
  loop                     Run the supervisor; \`foreman loop --help\` for its flags.

Options:
  -y, --yes                 Accept defaults for every prompt (non-interactive).
  --scope <user|project>     omp plugin install scope (default: prompted, "user").
  --omp <link|install|skip>  omp plugin mode; "link" symlinks this checkout ("dev mode").
  --herdr <link|install|skip> herdr board mode; defaults to skip when herdr isn't installed.
  --repo-source <owner/repo>  GitHub source for "install" modes (default: ${DEFAULT_GITHUB_REPO}).
  --repo <path>              Path to the foreman checkout (default: auto-detected).
  --home <path>              Home directory for ~/.foreman (default: real home; test hook).
  --skip-build                Skip \`bun install && bun run build\`.
  --skip-linear               Skip the Linear API key prompt.
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
    herdrMode: null,
    githubRepo: DEFAULT_GITHUB_REPO,
    repoPath: null,
    home: null,
    skipBuild: false,
    skipLinear: false,
    help: false,
  };

  const positionals = argv.filter((arg) => !arg.startsWith("-"));
  if (positionals[0] === "setup" || positionals[0] === "init") parsed.command = "setup";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "setup":
      case "init":
        break;
      case "-y":
      case "--yes":
        parsed.yes = true;
        break;
      case "--scope": {
        const value = argv[++i];
        if (value !== "user" && value !== "project") {
          throw new Error(`--scope must be one of user|project, got "${value ?? ""}"`);
        }
        parsed.scope = value;
        break;
      }
      case "--omp":
        parsed.ompMode = parseMode("--omp", argv[++i]);
        break;
      case "--herdr":
        parsed.herdrMode = parseMode("--herdr", argv[++i]);
        break;
      case "--repo-source": {
        const value = argv[++i];
        if (!value) throw new Error("--repo-source requires an owner/repo value");
        parsed.githubRepo = value;
        break;
      }
      case "--repo": {
        const value = argv[++i];
        if (!value) throw new Error("--repo requires a path");
        parsed.repoPath = value;
        break;
      }
      case "--home": {
        const value = argv[++i];
        if (!value) throw new Error("--home requires a path");
        parsed.home = value;
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
        throw new Error(`Unrecognized argument: ${arg}`);
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
    const repoRoot = resolveRepoRoot(args.repoPath);
    await runWizard(
      {
        home: args.home ?? homedir(),
        repoRoot,
        githubRepo: args.githubRepo,
        scope: args.scope,
        ompMode: nonInteractive ? (args.ompMode ?? "link") : args.ompMode,
        herdrMode: nonInteractive ? (args.herdrMode ?? "skip") : args.herdrMode,
        skipBuild: args.skipBuild,
        skipLinear: args.skipLinear || nonInteractive,
      },
      { prompter, runner: processRunner, log },
    );
  } finally {
    prompter.close();
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error(`[foreman] fatal: ${String(error)}`);
    process.exitCode = 1;
  });
}
