import { dirname, join, resolve } from "node:path";

export interface ForemanConfigFileSystem {
  exists(path: string): boolean;
  read(path: string): string;
}

export type ForemanConfigDiscovery =
  | { kind: "missing" }
  | { kind: "invalid"; path: string }
  | { kind: "configured"; path: string; mainBranch: string };

export interface ShellCommandAnalysis {
  cwd: string;
  fragments: string[];
  ambiguous: boolean;
  unresolvedInitialCwd: boolean;
  gitDirectoryOverride: boolean;
  mutations: GitMutation[];
  apparentMutation: GitMutation | undefined;
}

export type GitMutation =
  | "add"
  | "commit"
  | "merge"
  | "rebase"
  | "reset"
  | "restore"
  | "clean"
  | "cherry-pick"
  | "revert"
  | "rm"
  | "mv"
  | "stash"
  | "push"
  | "pull"
  | "checkout"
  | "switch"
  | "branch";

export interface GuardDecisionInput {
  analysis: ShellCommandAnalysis;
  config: ForemanConfigDiscovery;
  branch: string | undefined;
}

export interface GuardBlock {
  block: true;
  reason: string;
}

const MUTATING_SUBCOMMANDS: Record<string, true> = {
  add: true,
  commit: true,
  merge: true,
  rebase: true,
  reset: true,
  restore: true,
  clean: true,
  "cherry-pick": true,
  revert: true,
  rm: true,
  mv: true,
  stash: true,
  push: true,
};

const GIT_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--config-env": true,
};

const PUSH_OPTIONS_WITH_VALUE: Record<string, true> = {
  "--repo": true,
  "--receive-pack": true,
  "--exec": true,
  "--push-option": true,
  "-o": true,
};

type BranchRefMode = "create" | "delete" | "move" | "copy" | "force";

const BRANCH_OPTIONS_WITH_VALUE: Record<string, true> = {
  "-u": true,
  "--set-upstream-to": true,
  "--contains": true,
  "--no-contains": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "--format": true,
  "--color": true,
};

/**
 * Long options that can accompany `git branch <new-name> [<start-point>]`.
 * An option missing here suppresses the creation inference, which fails
 * open — so every documented creation option has to be listed.
 */
const CREATION_COMPATIBLE_OPTIONS: Record<string, true> = {
  "--quiet": true,
  "--track": true,
  "--no-track": true,
  "--force": true,
  "--recurse-submodules": true,
  "--create-reflog": true,
  "--no-create-reflog": true,
};

/** Finds the closest configuration so nested project commands use their project policy. */
export function discoverForemanConfig(cwd: string, fs: ForemanConfigFileSystem): ForemanConfigDiscovery {
  let directory = resolve(cwd);

  while (true) {
    const path = join(directory, ".omp", "foreman.json");
    if (fs.exists(path)) {
      try {
        const parsed: unknown = JSON.parse(fs.read(path));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "mainBranch" in parsed &&
          typeof parsed.mainBranch === "string" &&
          parsed.mainBranch.trim().length > 0
        ) {
          return { kind: "configured", path, mainBranch: parsed.mainBranch };
        }
      } catch {
        // A config that exists but cannot be read is unsafe to silently ignore.
      }
      return { kind: "invalid", path };
    }

    const parent = dirname(directory);
    if (parent === directory) return { kind: "missing" };
    directory = parent;
  }
}

/** Splits only shell list operators that are meaningful outside quotes. */
export function splitShellFragments(command: string): { fragments: string[]; ambiguous: boolean } {
  const fragments: string[] = [];
  let start = 0;
  let quote: "single" | "double" | undefined;
  let ambiguous = false;

  const pushFragment = (end: number) => {
    const fragment = command.slice(start, end).trim();
    if (fragment) fragments.push(fragment);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        quote = undefined;
      } else if (char === "$" && command[index + 1] === "(") {
        ambiguous = true;
      }
      continue;
    }

    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`" || char === "(" || char === ")" || char === "{" || char === "}") {
      ambiguous = true;
      continue;
    }

    const next = command[index + 1];
    let separatorLength = 0;
    if (char === "\n" || char === ";") {
      separatorLength = 1;
    } else if (char === "&") {
      separatorLength = next === "&" ? 2 : 1;
    } else if (char === "|") {
      separatorLength = next === "|" || next === "&" ? 2 : 1;
    }

    if (separatorLength > 0) {
      pushFragment(index);
      index += separatorLength - 1;
      start = index + 1;
    }
  }

  pushFragment(command.length);
  return { fragments, ambiguous: ambiguous || quote !== undefined };
}

/** Converts a simple leading `cd path && ...` into the directory Git will inspect. */
export function resolveInitialCwd(cwd: string, fragments: readonly string[]): {
  cwd: string;
  unresolved: boolean;
} {
  const first = fragments[0];
  if (!first) return { cwd, unresolved: false };

  const words = shellWords(first);
  if (!words || words[0] !== "cd") return { cwd, unresolved: false };

  const path = words[1] === "--" ? words[2] : words[1];
  const expectedLength = words[1] === "--" ? 3 : 2;
  if (
    words.length !== expectedLength ||
    !path ||
    path === "-" ||
    path.startsWith("~") ||
    /[$`(){}]/.test(path)
  ) {
    return { cwd, unresolved: true };
  }

  return { cwd: resolve(cwd, path), unresolved: false };
}

export function analyzeShellCommand(command: string, cwd: string): ShellCommandAnalysis {
  const split = splitShellFragments(command);
  const resolved = resolveInitialCwd(cwd, split.fragments);
  const gitDirectoryOverride = split.fragments.some((fragment) =>
    /\bgit\s+(?:(?:-C|--git-dir|--work-tree)(?:\s+|=))/.test(fragment),
  );
  const hasCompoundGrammar =
    /(?:^|[;&|]\s*)\b(?:if|then|elif|else|fi|for|while|until|case|esac|function|select|do|done|sh|bash|zsh)\b/.test(
      command,
    );
  const mutations = findGitMutations(split.fragments);

  return {
    cwd: resolved.cwd,
    fragments: split.fragments,
    ambiguous: split.ambiguous || hasCompoundGrammar,
    unresolvedInitialCwd: resolved.unresolved,
    gitDirectoryOverride,
    mutations,
    apparentMutation:
      mutations[0] ?? findApparentMutationInAmbiguousCommand(command, split.ambiguous || hasCompoundGrammar),
  };
}

/** Returns a blocking decision only when this command is unsafe under the discovered policy. */
export function decideMainBranchGuard(input: GuardDecisionInput): GuardBlock | undefined {
  const { analysis, config, branch } = input;
  const mutation = analysis.apparentMutation;
  if (!mutation) return undefined;

  if (analysis.unresolvedInitialCwd) {
    return {
      block: true,
      reason:
        "Foreman blocked an apparent Git mutation because its initial cd cannot be resolved safely. Default-branch changes must come through a PR; use a topic branch or worktree instead.",
    };
  }

  if (analysis.gitDirectoryOverride && config.kind === "configured") {
    return {
      block: true,
      reason: `Foreman blocked git ${mutation} because -C, --git-dir, or --work-tree changes the inspected repository. Default-branch changes must come through a PR; run the command from a topic worktree instead.`,
    };
  }

  if (config.kind === "invalid") {
    return {
      block: true,
      reason: `Foreman blocked an apparent Git mutation because ${config.path} is malformed or unreadable. Repair .omp/foreman.json before continuing; default-branch changes must come through a PR, and topic branches/worktrees are allowed.`,
    };
  }
  if (config.kind === "missing") return undefined;

  if (analysis.ambiguous && branch) {
    return {
      block: true,
      reason: `Foreman blocked an ambiguous shell command containing apparent git ${mutation} on branch "${branch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
    };
  }

  // Two kinds of rule, and conflating them is what produced both a false
  // positive and a hole. Most mutations act on whatever is checked out, so
  // they are judged by the current branch. `git branch` and `git push` name
  // their target explicitly, so they are judged by that name — which is why
  // they stay reachable from a detached HEAD, where there is no current
  // branch to compare against.
  const checkoutScoped = analysis.mutations.find((candidate) => candidate !== "branch") ?? mutation;
  if (branch === config.mainBranch && checkoutScoped !== "branch") {
    return {
      block: true,
      reason: `Foreman blocked git ${checkoutScoped} on configured default branch "${branch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
    };
  }

  if (branchMutatesDefaultBranch(analysis.fragments, config.mainBranch, branch)) {
    return {
      block: true,
      reason: `Foreman blocked git branch because it deletes, renames, or force-writes configured default branch "${config.mainBranch}". Default-branch changes must come through a PR; delete or rename a topic branch instead.`,
    };
  }

  if (pushesDefaultBranch(analysis.fragments, config.mainBranch)) {
    return {
      block: true,
      reason: `Foreman blocked git push because it explicitly targets configured default branch "${config.mainBranch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
    };
  }

  return undefined;
}

function findGitMutations(fragments: readonly string[]): GitMutation[] {
  const mutations: GitMutation[] = [];
  for (const fragment of fragments) {
    const mutation = parseGitInvocation(fragment)?.mutation;
    if (mutation) mutations.push(mutation);
  }
  return mutations;
}

function findApparentMutationInAmbiguousCommand(command: string, ambiguous: boolean): GitMutation | undefined {
  if (!ambiguous) return undefined;
  const match = /\bgit\s+(?:[^\s]+\s+){0,4}(add|commit|merge|rebase|reset|restore|clean|cherry-pick|revert|rm|mv|stash|push|pull|checkout)\b/.exec(
    command,
  );
  if (!match) return undefined;
  const subcommand = match[1]!;
  return subcommand === "pull" || subcommand === "checkout"
    ? subcommand
    : (subcommand as GitMutation);
}

function parseGitInvocation(fragment: string): { mutation: GitMutation | undefined; words: string[] } | undefined {
  const words = shellWords(fragment);
  if (!words) return undefined;

  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
  if (words[index] === "command") index += 1;
  if (words[index] !== "git") return undefined;
  index += 1;

  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") {
      index += 1;
      break;
    }
    if (!word.startsWith("-")) break;
    if (GIT_OPTIONS_WITH_VALUE[word]) {
      index += 2;
    } else {
      index += 1;
    }
  }

  const subcommand = words[index];
  if (!subcommand) return { mutation: undefined, words: [] };
  return {
    mutation: classifyGitSubcommand(subcommand, words.slice(index + 1)),
    words: words.slice(index),
  };
}

function classifyGitSubcommand(subcommand: string, args: readonly string[]): GitMutation | undefined {
  if (MUTATING_SUBCOMMANDS[subcommand]) return subcommand as GitMutation;
  if (subcommand === "pull") return args.includes("--ff-only") ? undefined : "pull";
  if (subcommand === "switch" && args.includes("--discard-changes")) return "switch";
  if (subcommand === "branch") return branchRefMode(args) ? "branch" : undefined;
  const separator = args.indexOf("--");
  if (subcommand === "checkout" && (separator >= 0 && separator < args.length - 1 || args.includes("-f"))) {
    return "checkout";
  }
  return undefined;
}

/**
 * Which local ref a `git branch` invocation writes, if any.
 *
 * Creation is *inferred* rather than flagged, so it is inferred only when
 * every option present is compatible with creating a branch. Anything else —
 * `--list`, `-a`, `-v`, `--format=…`, `--contains=…`, `--set-upstream-to=…` —
 * means the positionals are match patterns or an existing branch being
 * described, not a ref being written. A whitelist keeps that judgement
 * conservative as git grows options; an enumeration of listing flags would
 * silently start guessing wrong.
 *
 * `-r`/`--remotes` confines the operation to remote-tracking refs under
 * `refs/remotes/`, which can never be the local default branch.
 */
function branchRefMode(args: readonly string[]): { mode: BranchRefMode; remotes: boolean } | undefined {
  let mode: BranchRefMode | undefined;
  let force = false;
  let remotes = false;
  let creationCompatible = true;

  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;

    if (arg === "--delete") mode ??= "delete";
    else if (arg === "--move") mode ??= "move";
    else if (arg === "--copy") mode ??= "copy";
    else if (arg === "--force") force = true;
    else if (arg === "--remotes") remotes = true;
    else if (/^-[A-Za-z]+$/.test(arg)) {
      // Short flags cluster, so `-qD` has to be read letter by letter rather
      // than compared against the literal string "-D".
      for (const letter of arg.slice(1)) {
        if (letter === "d" || letter === "D") mode ??= "delete";
        else if (letter === "m" || letter === "M") mode ??= "move";
        else if (letter === "c" || letter === "C") mode ??= "copy";
        else if (letter === "f") force = true;
        else if (letter === "r") remotes = true;
        else if (letter !== "q" && letter !== "t") creationCompatible = false;
        if (letter === "D" || letter === "M" || letter === "C") force = true;
      }
    } else if (!CREATION_COMPATIBLE_OPTIONS[arg.split("=")[0]!]) {
      creationCompatible = false;
    }
  }

  if (!mode && force) mode = "force";
  // Creation still writes a ref, and writing one named for the default branch
  // is never what anyone meant in a repo that already has it.
  if (!mode && !remotes && creationCompatible && branchPositionals(args).length > 0) mode = "create";

  return mode ? { mode, remotes } : undefined;
}

function branchPositionals(args: readonly string[]): string[] {
  const positional: string[] = [];
  let index = 0;

  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg.startsWith("-")) {
      if (BRANCH_OPTIONS_WITH_VALUE[arg]) index += 1;
      continue;
    }
    positional.push(arg);
  }
  for (; index < args.length; index += 1) positional.push(args[index]!);

  return positional;
}

/**
 * True only when the invocation writes the default branch's own ref. Deleting
 * or renaming an unrelated topic branch leaves the default branch untouched,
 * so the current branch is irrelevant here — and a detached HEAD is no excuse.
 */
function branchMutatesDefaultBranch(
  fragments: readonly string[],
  mainBranch: string,
  currentBranch: string | undefined,
): boolean {
  for (const fragment of fragments) {
    const invocation = parseGitInvocation(fragment);
    if (invocation?.mutation !== "branch") continue;

    const args = invocation.words.slice(1);
    const classified = branchRefMode(args);
    if (!classified) continue;
    // `-r` operates on refs/remotes/*, so deleting `origin/main`'s cached
    // tracking ref never touches the local default branch.
    if (classified.remotes) continue;

    const positional = branchPositionals(args);
    let written: (string | undefined)[];
    switch (classified.mode) {
      case "delete":
        written = positional;
        break;
      case "move":
        // `-m <new>` renames whatever is checked out; `-m <old> <new>` names
        // both, and either end landing on the default branch destroys it.
        written = positional.length >= 2 ? positional.slice(0, 2) : [currentBranch, ...positional];
        break;
      case "copy":
        // Only the destination is written; copying *from* the default branch
        // reads it.
        written = positional.length >= 2 ? [positional[1]] : positional;
        break;
      case "create":
      case "force":
        written = positional.slice(0, 1);
        break;
    }

    if (written.some((name) => name === mainBranch || name === `refs/heads/${mainBranch}`)) return true;
  }

  return false;
}


function pushesDefaultBranch(fragments: readonly string[], mainBranch: string): boolean {
  for (const fragment of fragments) {
    const invocation = parseGitInvocation(fragment);
    if (invocation?.mutation !== "push") continue;
    if (pushTargetsDefaultBranch(invocation.words.slice(1), mainBranch)) return true;
  }
  return false;
}

function pushTargetsDefaultBranch(args: readonly string[], mainBranch: string): boolean {
  const positional: string[] = [];
  let deleteMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--delete" || arg === "-d") {
      deleteMode = true;
      continue;
    }
    if (arg.startsWith("--delete=")) {
      const deletedRef = arg.slice("--delete=".length);
      if (deletedRef === mainBranch || deletedRef === `refs/heads/${mainBranch}`) return true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (PUSH_OPTIONS_WITH_VALUE[arg]) index += 1;
      continue;
    }
    positional.push(arg);
  }

  // The first positional word is the remote; all later words are refspecs.
  for (let index = 1; index < positional.length; index += 1) {
    const refspec = positional[index]!;
    const colon = refspec.lastIndexOf(":");
    const target = colon >= 0 ? refspec.slice(colon + 1) : refspec;
    const targetRef = deleteMode ? refspec : target;
    if (targetRef === mainBranch || targetRef === `refs/heads/${mainBranch}`) return true;
  }
  return false;
}



/** A deliberately small shell-word reader: it never expands input or invokes a shell. */
function shellWords(fragment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let started = false;

  const pushWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };

  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index]!;

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else if (char === "\\" && index + 1 < fragment.length) word += fragment[++index]!;
      else word += char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushWord();
    } else if (char === "'") {
      quote = "single";
      started = true;
    } else if (char === '"') {
      quote = "double";
      started = true;
    } else if (char === "\\" && index + 1 < fragment.length) {
      word += fragment[++index]!;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }

  if (quote) return undefined;
  pushWord();
  return words;
}
