#!/usr/bin/env bun
/**
 * `foreman` CLI entrypoint.
 *
 * Five installer commands with disjoint scope, because the machine, a repo,
 * and the source checkout are three independently mutable things and folding
 * them together is what made the previous installer unreliable:
 *
 *   setup   per-machine — tool preflight, the Linear credential, and the one
 *           global plugin link at `~/.foreman/plugin`.
 *   init    per-repo — one `config.repos` entry, plus the two files that make
 *           the omp plugin active in that repo and nowhere else.
 *   deinit  per-repo — the exact inverse, so a repo can stop using Foreman
 *           without leaving a dangling plugin root behind.
 *   doctor  verification and repair for both layers. The activation surface
 *           is two files and a symlink, so drift is silent; this is what
 *           turns "it should be installed" into an answer.
 *   update  pull, rebuild, then repair drift. There is no per-repo install
 *           step: every repo links to `~/.foreman/plugin`, so rebuilding the
 *           checkout updates all of them at once.
 *
 * Hand-rolled argument parsing, same rationale as the loop CLIs: the
 * workspace's sole runtime dependency is `@sinclair/typebox`.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { nodeRunner } from "@foreman/core";
import { runBuild, runPlan, runReconcile } from "@foreman/loop";
import { resolveCheckoutRoot } from "./checkout.ts";
import { runDeinit } from "./deinit.ts";
import { runDoctor } from "./doctor.ts";
import { openUrl, processRunner } from "./exec.ts";
import { runInit } from "./init.ts";
import { InteractivePrompter, NonInteractivePrompter, type Prompter } from "./prompt.ts";
import { runUpdate } from "./update.ts";
import { renderVersion } from "./version.ts";
import { runWizard } from "./wizard.ts";

type Command = "setup" | "init" | "deinit" | "doctor" | "update";
interface ParsedArgs {
  command: Command | null;
  yes: boolean;
  /** Link the foreman CLI itself to this checkout's source; setup-only. */
  link: boolean;
  checkoutPath: string | null;
  path: string | null;
  home: string | null;
  skipLinear: boolean;
  /** Skip the omp plugin; init activates none, update re-asserts none. */
  skipPlugin: boolean;
  /** Refresh without touching git; update-only. */
  skipPull: boolean;
  /** Leave the `config.repos` entry in place; deinit-only. */
  keepRegistry: boolean;
  /** Also archive the workflow states `foreman init` created on this repo's Linear team; deinit-only. */
  revertLinear: boolean;
  /** Repair what it can instead of only reporting; doctor-only. */
  fix: boolean;
  help: boolean;
  version: boolean;
  apps: string[];
  alias: string | null;
  team: string | null;
}

/** One command's help content: the `Commands:` summary line, its `Usage:` argument shape, and its own options — everything `COMMAND_HELP` needs to render both the global listing and `foreman <command> --help`. */
interface CommandHelp {
  summary: string;
  usage: string;
  options: ReadonlyArray<readonly [flag: string, description: string]>;
}

const COMMAND_HELP: Record<Command, CommandHelp> = {
  setup: {
    summary: "Per-machine install: tool preflight, Linear credential, the global plugin link.",
    usage: "setup [options]",
    options: [
      ["--link", "Dev mode: run the foreman CLI from this checkout's source (no rebuild to see changes)."],
      ["--checkout <path>", "Path to the foreman checkout (default: auto-detected)."],
      ["--skip-linear", "Skip Linear API access."],
    ],
  },
  init: {
    summary: "Per-repo: register this directory and activate the omp plugin for it.",
    usage: "init [options]",
    options: [
      ["--path <dir>", "Directory to register (default: the current directory)."],
      ["--app <name>", "App in this repo; repeat for a monorepo."],
      ["--alias <name>", "Registry alias override (default: derived from the repo directory name)."],
      ["--team <KEY>", "Linear team for this repo (required; prompted when omitted)."],
      ["--skip-plugin", "Register the repo without activating the omp plugin in it."],
      ["--skip-linear", "Skip Linear API access."],
    ],
  },
  deinit: {
    summary: "Per-repo: deactivate the omp plugin here and drop the registry entry.",
    usage: "deinit [options]",
    options: [
      ["--path <dir>", "Directory to deactivate (default: the current directory)."],
      ["--keep-registry", "Deactivate the plugin but leave the `repos` entry in place."],
      ["--revert-linear", "Also archive the workflow states `foreman init` created on this repo's Linear team."],
    ],
  },
  doctor: {
    summary: "Verify the install — machine, plugin link, and every registered repo.",
    usage: "doctor [options]",
    options: [
      ["--fix", "Repair what can be repaired instead of only reporting it."],
      ["--checkout <path>", "Path to the foreman checkout, for repairing the global link."],
    ],
  },
  update: {
    summary: "Pull Foreman's source, rebuild, and repair any drift.",
    usage: "update [options]",
    options: [
      ["--checkout <path>", "Path to the foreman checkout (default: auto-detected)."],
      ["--skip-pull", "Rebuild and repair without touching git."],
      ["--skip-plugin", "Update the checkout only; leave the plugin link and repos alone."],
    ],
  },
};

/** Shared by every command's own help text — `renderCommandHelp` appends this after the command's own options. */
const SHARED_OPTIONS: ReadonlyArray<readonly [flag: string, description: string]> = [
  ["-y, --yes", "Accept defaults for every prompt (non-interactive)."],
  ["--home <path>", "Home directory for ~/.foreman (default: real home; test hook)."],
  ["--help, -h", "Show this text."],
];

/** Global-only: `--version` applies to no single command, so it is appended to `SHARED_OPTIONS` only in `renderGlobalHelp`, never in a per-command render. */
const GLOBAL_ONLY_OPTIONS: ReadonlyArray<readonly [flag: string, description: string]> = [
  ["--version", "Print the installed version and checkout revision."],
];

/** Renders one `flag  description` line, padded to line up the description column across every entry rendered together. */
function renderOptionLines(options: ReadonlyArray<readonly [flag: string, description: string]>): string {
  const width = Math.max(...options.map(([flag]) => flag.length)) + 4;
  return options.map(([flag, description]) => `  ${flag.padEnd(width)}${description}`).join("\n");
}

/** `foreman --help` / bare `foreman`: the command listing plus every command's own options, byte-identical to the pre-restructure `HELP_TEXT` constant. */
export function renderGlobalHelp(): string {
  const commandLines = (Object.keys(COMMAND_HELP) as Command[])
    .map((name) => `  ${name.padEnd(26)}${COMMAND_HELP[name].summary}`)
    .join("\n");
  const perCommandSections = (Object.keys(COMMAND_HELP) as Command[])
    .map((name) => `Options for ${name}:\n${renderOptionLines(COMMAND_HELP[name].options)}`)
    .join("\n\n");

  return `foreman — Foreman CLI

Usage: foreman <command> [options]

Commands:
${commandLines}
  plan                      Run the plan loop (triage/plan/refine); \`foreman plan --help\` for its flags.
  build                     Run the build loop (implement/review/merge); \`foreman build --help\` for its flags.
  reconcile                 Repair Linear drift from the invariant table; \`foreman reconcile --help\` for its flags.

Run \`setup\` once per machine, \`init\` once per repo, then \`plan\`/\`build\` per repo.
The plugin is active only in repos that ran \`init\`; \`doctor\` proves it.

${perCommandSections}

Options for all commands:
${renderOptionLines([...SHARED_OPTIONS, ...GLOBAL_ONLY_OPTIONS])}
`;
}

/** `foreman <command> --help` — that command's own usage and options only, matching `foreman build --help`'s house style. */
export function renderCommandHelp(command: Command): string {
  const help = COMMAND_HELP[command];
  return `foreman ${command} — ${help.summary}

Usage: foreman ${help.usage}

Options:
${renderOptionLines([...help.options, ...SHARED_OPTIONS])}
`;
}

/**
 * Rejects a flag aimed at the wrong command. Table-driven rather than a list
 * per command: several flags are deliberately shared by two or three of them —
 * \`--checkout\` by setup, doctor, and update; \`--skip-plugin\` by init and
 * update; `--path` by init and deinit — and silently accepting a misaimed flag
 * is how an operator ends up believing they skipped a step they didn't.
 */
function validateCommandFlags(parsed: ParsedArgs): void {
  const command = parsed.command;
  if (!command) return;

  const flags: { flag: string; supplied: boolean; commands: readonly Command[] }[] = [
    { flag: "--link", supplied: parsed.link, commands: ["setup"] },
    { flag: "--checkout", supplied: parsed.checkoutPath !== null, commands: ["setup", "doctor", "update"] },
    { flag: "--path", supplied: parsed.path !== null, commands: ["init", "deinit"] },
    { flag: "--app", supplied: parsed.apps.length > 0, commands: ["init"] },
    { flag: "--alias", supplied: parsed.alias !== null, commands: ["init"] },
    { flag: "--team", supplied: parsed.team !== null, commands: ["init"] },
    { flag: "--skip-linear", supplied: parsed.skipLinear, commands: ["setup", "init"] },
    { flag: "--skip-plugin", supplied: parsed.skipPlugin, commands: ["init", "update"] },
    { flag: "--skip-pull", supplied: parsed.skipPull, commands: ["update"] },
    { flag: "--keep-registry", supplied: parsed.keepRegistry, commands: ["deinit"] },
    { flag: "--revert-linear", supplied: parsed.revertLinear, commands: ["deinit"] },
    { flag: "--fix", supplied: parsed.fix, commands: ["doctor"] },
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
    checkoutPath: null,
    path: null,
    home: null,
    skipLinear: false,
    skipPlugin: false,
    skipPull: false,
    keepRegistry: false,
    revertLinear: false,
    fix: false,
    help: false,
    version: false,
    apps: [],
    alias: null,
    team: null,
  };

  const setCommand = (command: Command): void => {
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
      case "deinit":
      case "doctor":
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
      case "--keep-registry":
        parsed.keepRegistry = true;
        break;
      case "--revert-linear":
        parsed.revertLinear = true;
        break;
      case "--fix":
        parsed.fix = true;
        break;
      case "--link":
        parsed.link = true;
        break;
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
      case "--app": {
        if (argv[i + 1] === undefined) throw new Error("missing value for --app");
        parsed.apps.push(argv[++i] as string);
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
      case "--version":
      case "-V":
        parsed.version = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unrecognized argument: ${arg}. Run \`foreman --help\` for the flag list.`);
        }
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
   * `plan`, `build`, and `reconcile` each own every argument after them.
   * Delegating before this CLI's own parser runs is what lets those
   * processes keep their own flags (`--mode`, `--once`, `--dry-run`)
   * without this parser knowing any.
   */
  if (argv[0] === "plan") {
    await runPlan(argv.slice(1));
    return;
  }
  if (argv[0] === "build") {
    await runBuild(argv.slice(1));
    return;
  }
  if (argv[0] === "reconcile") {
    await runReconcile(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(await renderVersion(args.checkoutPath));
    return;
  }
  if (args.help && args.command) {
    process.stdout.write(renderCommandHelp(args.command));
    return;
  }
  if (args.help || !args.command) {
    process.stdout.write(renderGlobalHelp());
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const nonInteractive = args.yes || !process.stdin.isTTY;
  const prompter: Prompter = nonInteractive ? new NonInteractivePrompter() : new InteractivePrompter();
  const log = (message: string): void => console.log(message);
  const home = args.home ?? homedir();

  try {
    /*
     * `init` and `deinit` deliberately skip `resolveCheckoutRoot`: that
     * resolves the *foreman checkout* (it looks for `packages/omp-plugin`) and
     * would reject the arbitrary product repo they operate on. Both reach the
     * plugin through `~/.foreman/plugin` instead, which is exactly why that
     * indirection exists.
     */
    if (args.command === "init") {
      await runInit(
        {
          cwd: args.path ?? process.cwd(),
          home,
          skipLinear: args.skipLinear,
          skipPlugin: args.skipPlugin,
          apps: args.apps.length > 0 ? args.apps : undefined,
          alias: args.alias ?? undefined,
          team: args.team ?? undefined,
          nonInteractive,
        },
        { prompter, log, git: nodeRunner, openUrl: nonInteractive ? undefined : openUrl },
      );
      return;
    }

    if (args.command === "deinit") {
      await runDeinit(
        { cwd: args.path ?? process.cwd(), home, keepRegistry: args.keepRegistry, revertLinear: args.revertLinear, yes: args.yes },
        { prompter, log, git: nodeRunner },
      );
      return;
    }

    /*
     * `doctor` takes the checkout path unresolved: a machine whose checkout
     * has moved is precisely the drift it exists to diagnose, so failing to
     * resolve it here would turn the diagnosis into a crash.
     */
    if (args.command === "doctor") {
      process.exitCode = await runDoctor(
        { home, checkoutRoot: args.checkoutPath, fix: args.fix, yes: args.yes },
        { runner: processRunner, log },
      );
      return;
    }

    /*
     * `update` resolves the checkout the same way `setup` does — it rebuilds
     * that source tree — but takes no prompts: every step is derived from the
     * registry and the checkout's git state, so there is nothing to ask.
     */
    if (args.command === "update") {
      const failures = await runUpdate(
        {
          checkoutRoot: resolveCheckoutRoot(args.checkoutPath),
          home,
          skipPull: args.skipPull,
          skipPlugin: args.skipPlugin,
        },
        { runner: processRunner, log },
      );
      process.exitCode = failures > 0 ? 1 : 0;
      return;
    }

    process.exitCode = await runWizard(
      {
        home,
        checkoutRoot: resolveCheckoutRoot(args.checkoutPath),
        linkCli: args.link,
        skipLinear: args.skipLinear,
        yes: args.yes,
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
 * argv[1] pointing at the symlink while `import.meta.url` already reflected
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
