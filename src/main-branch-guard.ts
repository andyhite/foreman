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
  if (config.kind === "missing" || !branch) return undefined;

  if (analysis.ambiguous) {
    return {
      block: true,
      reason: `Foreman blocked an ambiguous shell command containing apparent git ${mutation} on branch "${branch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
    };
  }

  if (branch === config.mainBranch) {
    return {
      block: true,
      reason: `Foreman blocked git ${mutation} on configured default branch "${branch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
    };
  }

  if (pushesDefaultBranch(analysis.fragments, config.mainBranch)) {
    return {
      block: true,
      reason: `Foreman blocked git push from branch "${branch}" because it explicitly targets configured default branch "${config.mainBranch}". Default-branch changes must come through a PR; use a topic branch or worktree instead.`,
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
  if (subcommand === "branch" && (args.includes("-d") || args.includes("-D") || args.includes("--delete"))) {
    return "branch";
  }
  const separator = args.indexOf("--");
  if (subcommand === "checkout" && (separator >= 0 && separator < args.length - 1 || args.includes("-f"))) {
    return "checkout";
  }
  return undefined;
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
