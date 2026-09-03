#!/usr/bin/env node
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
 *   verify  verification and repair for both layers. The activation surface
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
import { openUrl, processRunner } from "./exec.ts";
import { runInit } from "./init.ts";
import { InteractivePrompter, NonInteractivePrompter, type Prompter } from "./prompt.ts";
import { runUpdate } from "./update.ts";
import { runVerify } from "./verify.ts";
import { runWizard } from "./wizard.ts";

type Command = "setup" | "init" | "deinit" | "verify" | "update";
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
  /** Repair what it can instead of only reporting; verify-only. */
  fix: boolean;
  help: boolean;
  initiatives: string[];
  alias: string | null;
  team: string | null;
}

const HELP_TEXT = `foreman — Foreman CLI

Usage: foreman <command> [options]

Commands:
  setup                    Per-machine install: tool preflight, Linear credential, the global plugin link.
  init                     Per-repo: register this directory and activate the omp plugin for it.
  deinit                   Per-repo: deactivate the omp plugin here and drop the registry entry.
  verify                   Verify the install — machine, plugin link, and every registered repo.
  update                   Pull Foreman's source, rebuild, and repair any drift.
  plan                     Run the plan loop (triage/plan/refine); \`foreman plan --help\` for its flags.
  build                    Run the build loop (implement/review/merge); \`foreman build --help\` for its flags.
  reconcile                Repair Linear drift from the invariant table; \`foreman reconcile --help\` for its flags.

Run \`setup\` once per machine, \`init\` once per repo, then \`plan\`/\`build\` per repo.
The plugin is active only in repos that ran \`init\`; \`verify\` proves it.

Options for setup:
  --link                     Dev mode: run the foreman CLI from this checkout's source (no rebuild to see changes).
  --checkout <path>          Path to the foreman checkout (default: auto-detected).
  --skip-linear              Skip Linear API access.

Options for init:
  --path <dir>               Directory to register (default: the current directory).
  --initiative <id>          Initiative to bind; repeat for multiple. Accepts <uuid> or <uuid>:<subdir>.
  --alias <name>             Registry alias override (default: derived from the repo directory name).
  --team <KEY>               Linear team key for this repo (default: prompted, or sole workspace team).
  --skip-plugin              Register the repo without activating the omp plugin in it.
  --skip-linear              Skip Linear API access.

Options for deinit:
  --path <dir>               Directory to deactivate (default: the current directory).
  --keep-registry            Deactivate the plugin but leave the \`repos\` entry in place.

Options for verify:
  --fix                      Repair what can be repaired instead of only reporting it.
  --checkout <path>          Path to the foreman checkout, for repairing the global link.

Options for update:
  --checkout <path>          Path to the foreman checkout (default: auto-detected).
  --skip-pull                Rebuild and repair without touching git.
  --skip-plugin              Update the checkout only; leave the plugin link and repos alone.

Options for all commands:
  -y, --yes                  Accept defaults for every prompt (non-interactive).
  --home <path>              Home directory for ~/.foreman (default: real home; test hook).
  --help, -h                 Show this text.
`;

/**
 * Rejects a flag aimed at the wrong command. Table-driven rather than a list
 * per command: several flags are deliberately shared by two or three of them —
 * `--checkout` by setup, verify, and update; `--skip-plugin` by init and
 * update; `--path` by init and deinit — and silently accepting a misaimed flag
 * is how an operator ends up believing they skipped a step they didn't.
 */
function validateCommandFlags(parsed: ParsedArgs): void {
  const command = parsed.command;
  if (!command) return;

  const flags: { flag: string; supplied: boolean; commands: readonly Command[] }[] = [
    { flag: "--link", supplied: parsed.link, commands: ["setup"] },
    { flag: "--checkout", supplied: parsed.checkoutPath !== null, commands: ["setup", "verify", "update"] },
    { flag: "--path", supplied: parsed.path !== null, commands: ["init", "deinit"] },
    { flag: "--initiative", supplied: parsed.initiatives.length > 0, commands: ["init"] },
    { flag: "--alias", supplied: parsed.alias !== null, commands: ["init"] },
    { flag: "--team", supplied: parsed.team !== null, commands: ["init"] },
    { flag: "--skip-linear", supplied: parsed.skipLinear, commands: ["setup", "init"] },
    { flag: "--skip-plugin", supplied: parsed.skipPlugin, commands: ["init", "update"] },
    { flag: "--skip-pull", supplied: parsed.skipPull, commands: ["update"] },
    { flag: "--keep-registry", supplied: parsed.keepRegistry, commands: ["deinit"] },
    { flag: "--fix", supplied: parsed.fix, commands: ["verify"] },
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
    fix: false,
    help: false,
    initiatives: [],
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
      case "verify":
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
  if (args.help || !args.command) {
    process.stdout.write(HELP_TEXT);
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
          initiatives: args.initiatives.length > 0 ? args.initiatives : undefined,
          alias: args.alias ?? undefined,
          team: args.team ?? undefined,
        },
        { prompter, log, git: nodeRunner, openUrl: nonInteractive ? undefined : openUrl },
      );
      return;
    }

    if (args.command === "deinit") {
      await runDeinit(
        { cwd: args.path ?? process.cwd(), home, keepRegistry: args.keepRegistry },
        { prompter, log, git: nodeRunner },
      );
      return;
    }

    /*
     * `verify` takes the checkout path unresolved: a machine whose checkout
     * has moved is precisely the drift it exists to diagnose, so failing to
     * resolve it here would turn the diagnosis into a crash.
     */
    if (args.command === "verify") {
      process.exitCode = await runVerify(
        { home, checkoutRoot: args.checkoutPath, fix: args.fix },
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
      await runUpdate(
        {
          checkoutRoot: resolveCheckoutRoot(args.checkoutPath),
          home,
          skipPull: args.skipPull,
          skipPlugin: args.skipPlugin,
        },
        { runner: processRunner, log },
      );
      return;
    }

    await runWizard(
      {
        home,
        checkoutRoot: resolveCheckoutRoot(args.checkoutPath),
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
