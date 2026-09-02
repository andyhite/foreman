#!/usr/bin/env node
/**
 * `foreman` CLI entrypoint.
 *
 * Two installer commands with disjoint scope: `setup` is per-machine (tool
 * preflight, Linear credential, omp marketplace catalog) and `init` is
 * per-repo (writes one `config.repos` entry and installs the omp plugin
 * scoped to that repo). They were one command with `init` as an alias,
 * which meant installing the machine-level pieces and registering a repo
 * could not be done independently — re-running to add a repo re-ran the
 * whole installer.
 *
 * Hand-rolled argument parsing, same rationale as `foreman repo`: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { nodeRunner } from "@foreman/core";
import { runRepo, runTeam } from "@foreman/loop";
import { processRunner } from "./exec.ts";
import { runInit } from "./init.ts";
import { DEFAULT_GITHUB_REPO } from "./plugin-commands.ts";
import { InteractivePrompter, NonInteractivePrompter, type Prompter } from "./prompt.ts";
import { resolveCheckoutRoot } from "./checkout.ts";
import { runWizard } from "./wizard.ts";
import { runUpdate } from "./update.ts";

interface ParsedArgs {
  command: "setup" | "init" | "update" | null;
  yes: boolean;
  /** Link the foreman CLI itself to this checkout's source; setup-only. */
  link: boolean;
  githubRepo: string;
  checkoutPath: string | null;
  path: string | null;
  home: string | null;
  skipLinear: boolean;
  /** Skip the omp plugin; init installs none, update refreshes none. */
  skipPlugin: boolean;
  /** Refresh without touching git; update-only. */
  skipPull: boolean;
  help: boolean;
  initiatives: string[];
  alias: string | null;
  team: string | null;
}

const HELP_TEXT = `foreman — Foreman CLI

Usage: foreman <command> [options]

Commands:
  setup                    Per-machine install: tool preflight, Linear credential, omp marketplace catalog.
  init                     Per-repo: register this directory in the repos registry and install the omp plugin for it.
  update                   Pull Foreman's source, rebuild the CLI, and re-sync the omp plugin in every registered repo.
  repo                     Run the per-repo supervisor; \`foreman repo --help\` for its flags.
  team                     Run the team-level triage process; \`foreman team --help\` for its flags.

Run \`setup\` once per machine, \`init\` once per repo, then \`repo\` per repo.
Run \`update\` after pulling or pushing changes to bring the machine current.

Options for setup:
  --link                     Dev mode: link the foreman CLI to this checkout's source (no rebuild-to-see-changes).
  --repo-source <owner/repo>  GitHub source for the omp marketplace catalog (default: ${DEFAULT_GITHUB_REPO}).
  --checkout <path>          Path to the foreman checkout (default: auto-detected).
  --skip-linear               Skip Linear API access.

Options for init:
  --path <dir>               Directory to register (default: the current directory).
  --initiative <id>          Initiative to bind; repeat for multiple. Accepts <uuid> or <uuid>:<subdir>.
  --alias <name>             Registry alias override (default: derived from the repo directory name).
  --team <KEY>               Linear team key for this repo (default: prompted, or sole workspace team).
  --skip-plugin               Skip installing the omp plugin for this repo.
  --skip-linear               Skip Linear API access.

Options for update:
  --checkout <path>          Path to the foreman checkout (default: auto-detected).
  --skip-pull                Rebuild and refresh plugins without touching git.
  --skip-plugin               Update the checkout only; leave omp alone.

Options for all commands:
  -y, --yes                 Accept defaults for every prompt (non-interactive).
  --home <path>              Home directory for ~/.foreman (default: real home; test hook).
  --help, -h                  Show this text.
`;

/**
 * Rejects a flag aimed at the wrong command. Table-driven rather than the
 * previous pair of "setup-only"/"init-only" lists: with a third command and
 * flags deliberately shared by two of them — `--checkout` by setup and
 * update, `--skip-plugin` by init and update — a pairwise scheme no longer
 * describes the surface, and silently accepting a misaimed flag is how an
 * operator ends up believing they skipped a step they didn't.
 */
function validateCommandFlags(parsed: ParsedArgs): void {
  const command = parsed.command;
  if (!command) return;

  const flags: { flag: string; supplied: boolean; commands: readonly string[] }[] = [
    { flag: "--link", supplied: parsed.link, commands: ["setup"] },
    { flag: "--repo-source", supplied: parsed.githubRepo !== DEFAULT_GITHUB_REPO, commands: ["setup"] },
    { flag: "--checkout", supplied: parsed.checkoutPath !== null, commands: ["setup", "update"] },
    { flag: "--path", supplied: parsed.path !== null, commands: ["init"] },
    { flag: "--initiative", supplied: parsed.initiatives.length > 0, commands: ["init"] },
    { flag: "--alias", supplied: parsed.alias !== null, commands: ["init"] },
    { flag: "--team", supplied: parsed.team !== null, commands: ["init"] },
    { flag: "--skip-linear", supplied: parsed.skipLinear, commands: ["setup", "init"] },
    { flag: "--skip-plugin", supplied: parsed.skipPlugin, commands: ["init", "update"] },
    { flag: "--skip-pull", supplied: parsed.skipPull, commands: ["update"] },
  ];

  for (const entry of flags) {
    if (!entry.supplied || entry.commands.includes(command)) continue;
    const owners = entry.commands.map((name) => `\`foreman ${name}\``).join(" or ");
    throw new Error(
      `${entry.flag} applies to ${owners}, not \`foreman ${command}\`. Run \`foreman --help\` for the command list.`,
    );
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    yes: false,
    link: false,
    githubRepo: DEFAULT_GITHUB_REPO,
    checkoutPath: null,
    path: null,
    home: null,
    skipLinear: false,
    skipPlugin: false,
    skipPull: false,
    help: false,
    initiatives: [],
    alias: null,
    team: null,
  };

  const setCommand = (command: "setup" | "init" | "update"): void => {
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
      case "update":
        setCommand(arg);
        break;
      case "-y":
      case "--yes":
        parsed.yes = true;
        break;
      case "--skip-pull":
        parsed.skipPull = true;
        break;
      case "--link":
        parsed.link = true;
        break;
      case "--repo-source": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --repo-source");
        parsed.githubRepo = argv[++i] as string;
        break;
      }
      case "--checkout": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --checkout");
        parsed.checkoutPath = argv[++i] as string;
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
      case "--skip-linear":
        parsed.skipLinear = true;
        break;
      case "--skip-plugin":
        parsed.skipPlugin = true;
        break;
      case "--initiative": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --initiative");
        parsed.initiatives.push(argv[++i] as string);
        break;
      }
      case "--alias": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --alias");
        parsed.alias = argv[++i] as string;
        break;
      }
      case "--team": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --team");
        parsed.team = argv[++i] as string;
        break;
      }
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unrecognized argument: ${arg}`);
        if (!parsed.command) {
          throw new Error(`Unknown command "${arg}". Run \`foreman --help\` for the command list.`);
        }
        throw new Error(`Unexpected positional argument "${arg}"; expected a command or an option value.`);
    }
  }
  validateCommandFlags(parsed);
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  /*
   * `repo` owns every argument after it. Delegating before this CLI's own
   * parser runs is what lets the supervisor keep its flags (`--mode`,
   * `--once`) without this parser having to know any of them.
   */
  if (argv[0] === "repo") {
    await runRepo(argv.slice(1));
    return;
  }

  /*
   * `team` owns every argument after it, same rationale as `repo`: the
   * team-level process keeps its own flags (`--once`, `--verbose`) without
   * this parser having to know any of them.
   */
  if (argv[0] === "team") {
    await runTeam(argv.slice(1));
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
     * `init` deliberately skips `resolveCheckoutRoot`: that resolves the
     * *foreman checkout* (it looks for `packages/omp-plugin`) and would reject
     * the arbitrary product repo `init` is meant to register.
     */
    if (args.command === "init") {
      await runInit(
        {
          cwd: args.path ?? process.cwd(),
          home: args.home ?? homedir(),
          skipLinear: args.skipLinear,
          skipPlugin: args.skipPlugin,
          initiatives: args.initiatives.length > 0 ? args.initiatives : undefined,
          alias: args.alias ?? undefined,
          team: args.team ?? undefined,
        },
        { prompter, log, git: nodeRunner, runner: processRunner },
      );
      return;
    }

    /*
     * `update` resolves the checkout the same way `setup` does — it rebuilds
     * that source tree — but takes no prompts: every step is derived from the
     * registry and the checkout's git state, so there is nothing to ask.
     */
    if (args.command === "update") {
      await runUpdate(
        {
          checkoutRoot: resolveCheckoutRoot(args.checkoutPath),
          home: args.home ?? homedir(),
          skipPull: args.skipPull,
          skipPlugin: args.skipPlugin,
        },
        { runner: processRunner, log },
      );
      return;
    }

    const checkoutRoot = resolveCheckoutRoot(args.checkoutPath);
    await runWizard(
      {
        home: args.home ?? homedir(),
        checkoutRoot,
        githubRepo: args.githubRepo,
        linkCli: args.link,
        skipLinear: args.skipLinear,
      },
      { prompter, runner: processRunner, log },
    );
  } finally {
    prompter.close();
  }
}

/*
 * Compares against the *resolved* argv[1] path, encoded via `pathToFileURL`
 * rather than a hand-built `file://` prefix: a space, `#`, or `%` anywhere in
 * the install directory needs URL-escaping that `import.meta.url` already
 * carries, and a naive template-string prefix never does. Node also does not
 * resolve symlinks when populating argv[1] (Bun does), so invoking this file
 * through a symlinked `foreman` binary — the normal install shape — left
 * argv[1] pointing at the symlink while `import.meta.url` already reflects
 * the real path underneath; `realpathSync` closes that gap too.
 */
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
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
