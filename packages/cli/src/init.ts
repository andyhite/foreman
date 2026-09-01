/**
 * `foreman init` — registers the current repo as an entry in the global
 * `config.repos` registry (SPEC §3.10, §3.11).
 *
 * Unlike `foreman setup` (tool preflight, the Linear key, plugin install),
 * this runs *inside* a target repo and only ever touches that repo's own
 * registry entry: no preflight, no key prompt/write (it reads whatever
 * `foreman setup` already configured), no plugin install, no build. Running
 * it a second time for the same repo updates the existing entry instead of
 * creating a duplicate, which is how a monorepo grows a second bound
 * initiative over time.
 */

import {
  type CommandRunner,
  type InitiativeBinding,
  type InitiativeRef,
  LinearApiError,
  LinearClient,
  boundInitiativeIds,
  expandHome,
  loadGlobalConfig,
  resolveLinearApiKey,
  type RepoEntry,
  type TeamRef,
} from "@foreman/core";
import { basename } from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "./global-config.ts";
import type { CheckboxChoice, Prompter } from "./prompt.ts";
import { printSection, style } from "./tui.ts";

export interface InitOptions {
  /** Directory being registered; the git repo root is resolved from it. */
  cwd: string;
  home: string;
  /** Skip Linear entirely and take manual initiative ids. */
  skipLinear: boolean;
  /** Non-interactive initiative bindings (`<uuid>` or `<uuid>:<subdir>`). */
  initiatives?: string[];
  /** Non-interactive registry alias override. */
  alias?: string;
  /** Non-interactive Linear team key. */
  team?: string;
}

export interface InitDeps {
  prompter: Prompter;
  log: (message: string) => void;
  /** `nodeRunner` from `@foreman/core`; captures stdout, unlike cli's own `Runner`. */
  git: CommandRunner;
}

/** Parses `--initiative <uuid>` or `--initiative <uuid>:<subdir>`. */
function parseInitiativeArg(raw: string): InitiativeBinding {
  const colon = raw.indexOf(":");
  if (colon === -1) {
    const id = raw.trim();
    if (id.length === 0) throw new Error(`Invalid --initiative "${raw}": initiative id is required.`);
    return id;
  }
  const id = raw.slice(0, colon).trim();
  const subdir = raw.slice(colon + 1).trim();
  if (id.length === 0) throw new Error(`Invalid --initiative "${raw}": missing id before ":".`);
  return subdir.length > 0 ? { id, path: subdir } : id;
}

/** `git rev-parse --show-toplevel`, so running from a subdirectory still registers the repo root. */
async function resolveRepoRoot(cwd: string, git: CommandRunner): Promise<string> {
  try {
    const { stdout } = await git.run(["git", "rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    if (root.length === 0) throw new Error("empty toplevel");
    return root;
  } catch {
    throw new Error("`foreman init` must be run inside a git repository.");
  }
}

/** Kebab-cases a repo path's basename for the registry alias default, e.g. "~/Code/Plotroom API" -> "plotroom-api". */
function deriveAlias(repoPath: string): string {
  const base = basename(repoPath.replace(/\/+$/, ""));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "repo";
}

/** The registry entry already at `repoRoot`, if any, keyed by whatever alias it's currently filed under. */
function findEntryByPath(
  repos: Record<string, RepoEntry>,
  repoRoot: string,
  home: string,
): { alias: string; entry: RepoEntry } | null {
  const expandedRoot = expandHome(repoRoot, home);
  for (const [alias, entry] of Object.entries(repos)) {
    if (expandHome(entry.path, home) === expandedRoot) return { alias, entry };
  }
  return null;
}

/** Resolves the Linear API key `foreman setup` already configured, or null when there isn't one to try. */
async function resolveConfiguredApiKey(options: InitOptions): Promise<string | null> {
  if (options.skipLinear) return null;
  try {
    const { config } = loadGlobalConfig({ home: options.home });
    return resolveLinearApiKey(config);
  } catch {
    return null;
  }
}

interface InitiativePick {
  ids: string[];
  /** id → name, when known (API path only) — lets prompts and summaries reference initiatives by name. */
  names: Map<string, string>;
  /** The workspace's sole team key, when the API path was used and unambiguous. */
  soleTeamKey: string | null;
}

/** Manual fallback: a single comma-separated prompt, pre-filled from whatever's already bound. */
async function pickInitiativeIdsManually(deps: InitDeps, boundIds: Set<string>): Promise<InitiativePick> {
  deps.log(
    style(
      "gray",
      "  initiative ids are UUIDs, e.g. a1b2c3d4-0000-0000-0000-000000000000 — find one in Linear's URL when viewing the initiative",
    ),
  );
  const manualInput = await deps.prompter.text(
    "Linear initiative id(s) this repo hosts (comma-separated)",
    [...boundIds].join(", "),
  );
  const ids = manualInput
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return { ids, names: new Map(), soleTeamKey: null };
}

/**
 * Fetches every initiative in the workspace and lets the operator check the
 * ones this repo hosts, pre-checking initiatives already bound to this
 * entry and hinting ones already bound to a *different* alias — binding one
 * initiative to two repos is rejected at load time by the uniqueness check
 * (SPEC §3.10), so this warns at the prompt rather than let the operator
 * write a config that won't load. Falls back to manual entry on any API
 * failure or an empty workspace, never dead-ending the command.
 */
async function pickInitiativeIds(
  deps: InitDeps,
  apiKey: string,
  boundIds: Set<string>,
  boundElsewhere: Map<string, string>,
): Promise<InitiativePick> {
  const client = new LinearClient({ apiKey });
  let initiatives: InitiativeRef[];
  let teams: TeamRef[];
  try {
    [initiatives, teams] = await Promise.all([client.initiatives(), client.teams()]);
  } catch (error) {
    const message = error instanceof LinearApiError ? error.message : String(error);
    deps.log(`  ${style("yellow", "!")} couldn't reach the Linear API (${message}) — falling back to manual entry.`);
    return pickInitiativeIdsManually(deps, boundIds);
  }
  if (initiatives.length === 0) {
    deps.log(`  ${style("yellow", "!")} no initiatives found in this Linear workspace — falling back to manual entry.`);
    return pickInitiativeIdsManually(deps, boundIds);
  }

  const sorted = [...initiatives].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(sorted.map((initiative) => [initiative.id, initiative.name]));
  const choices: Array<CheckboxChoice<string>> = sorted.map((initiative) => {
    const elsewhereAlias = boundElsewhere.get(initiative.id);
    return {
      value: initiative.id,
      label: initiative.name,
      checked: boundIds.has(initiative.id),
      hint: elsewhereAlias ? `already bound to repos.${elsewhereAlias}` : undefined,
    };
  });
  const ids = await deps.prompter.multiSelect("Which Linear initiatives does this repo host?", choices);
  const soleTeam = teams.length === 1 ? teams[0] : undefined;
  return { ids, names, soleTeamKey: soleTeam?.key ?? null };
}

/** Per-initiative optional subdirectory hint (SPEC §3.10) — blank writes the bare id, not `{ id, path: "" }`. */
async function pickInitiativeBindings(
  deps: InitDeps,
  ids: string[],
  existingEntry: RepoEntry | null,
  names: Map<string, string>,
): Promise<InitiativeBinding[]> {
  const existingPathById = new Map<string, string>();
  for (const binding of existingEntry?.initiatives ?? []) {
    if (typeof binding !== "string" && binding.path) existingPathById.set(binding.id, binding.path);
  }

  const bindings: InitiativeBinding[] = [];
  for (const id of ids) {
    const subdir = await deps.prompter.text(
      `Subdirectory for initiative "${names.get(id) ?? id}" (blank = repo root)`,
      existingPathById.get(id) ?? "",
    );
    bindings.push(subdir.length > 0 ? { id, path: subdir } : id);
  }
  return bindings;
}

/** `origin/HEAD`'s branch, falling back to the current branch when there's no such remote-tracking ref. */
async function detectBaseBranch(repoRoot: string, git: CommandRunner): Promise<string> {
  try {
    const { stdout } = await git.run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoRoot,
    });
    const ref = stdout.trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  } catch {
    const { stdout } = await git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  }
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<void> {
  printSection(deps.log, "Register this repo (config.repos)");

  const repoRoot = await resolveRepoRoot(options.cwd, deps.git);
  const existing = readGlobalConfig(options.home);
  const existingByPath = findEntryByPath(existing.repos, repoRoot, options.home);

  const defaultAlias = existingByPath?.alias ?? deriveAlias(repoRoot);
  const aliasInput =
    options.alias !== undefined
      ? options.alias
      : await deps.prompter.text("Registry alias for this repo", defaultAlias);
  const alias = aliasInput.length > 0 ? aliasInput : defaultAlias;

  // Prefer an entry already filed at this path; fall back to one already filed
  // under the (possibly operator-edited) alias — either way, re-running
  // updates that entry in place instead of creating a duplicate. An alias
  // already claimed by a *different* path is a collision, not "this repo's
  // existing entry" — treating it as one would silently overwrite the other
  // repo's registration below.
  const aliasEntry = existing.repos[alias] ?? null;
  if (aliasEntry && aliasEntry.path !== repoRoot && existingByPath?.alias !== alias) {
    throw new Error(
      `Alias "${alias}" is already registered to ${aliasEntry.path}; this repo is ${repoRoot}. ` +
        "Pick a different alias, or run `foreman init` from the other repo to free it up first.",
    );
  }
  const existingEntry = existingByPath?.entry ?? aliasEntry;
  if (existingEntry) {
    deps.log(`  ${style("cyan", "i")} "${alias}" is already registered at ${existingEntry.path} — updating it.`);
  }

  const boundIds = new Set(existingEntry ? boundInitiativeIds(existingEntry) : []);
  const boundElsewhere = new Map<string, string>();
  for (const [otherAlias, entry] of Object.entries(existing.repos)) {
    if (otherAlias === alias || otherAlias === existingByPath?.alias) continue;
    for (const id of boundInitiativeIds(entry)) boundElsewhere.set(id, otherAlias);
  }
  const apiKey = await resolveConfiguredApiKey(options);
  const cliInitiatives = options.initiatives?.map(parseInitiativeArg) ?? null;
  const picked = cliInitiatives
    ? {
        ids: cliInitiatives.map((binding) => (typeof binding === "string" ? binding : binding.id)),
        names: new Map<string, string>(),
        soleTeamKey: null,
      }
    : apiKey
      ? await pickInitiativeIds(deps, apiKey, boundIds, boundElsewhere)
      : await pickInitiativeIdsManually(deps, boundIds);

  const bindings = cliInitiatives ?? (await pickInitiativeBindings(deps, picked.ids, existingEntry, picked.names));

  /*
   * An entry with no initiatives is rejected by the loader's own validation, so
   * catching it here turns an opaque schema error into the actual problem:
   * nothing was selected. A non-interactive run on a brand-new repo lands here
   * every time, since there is no prior binding to pre-check.
   */
  if (bindings.length === 0) {
    throw new Error(
      `No initiatives selected, so "${alias}" would resolve to no Linear work. ` +
        "Re-run `foreman init` and pick at least one initiative, " +
        "pass one or more --initiative flags, or use --skip-linear to type the ids by hand.",
    );
  }

  const defaultTeam = existingEntry?.team ?? picked.soleTeamKey ?? "";
  const team =
    options.team !== undefined
      ? options.team.trim()
      : (await deps.prompter.text("Linear team key for this repo (blank = resolve at runtime)", defaultTeam)).trim();

  const baseBranch = await detectBaseBranch(repoRoot, deps.git);

  const entry: RepoEntry = {
    path: repoRoot,
    initiatives: bindings,
    ...(team.length > 0 ? { team } : {}),
    // Writing today's default back out would pin it forever the next time
    // the schema's default changes underneath an untouched config — see
    // global-config.ts's header comment.
    ...(baseBranch !== "main" ? { baseBranch } : {}),
  };

  const removeRepos = existingByPath && existingByPath.alias !== alias ? [existingByPath.alias] : [];
  const candidateRepos = { ...existing.repos, [alias]: entry };
  for (const obsoleteAlias of removeRepos) delete candidateRepos[obsoleteAlias];
  const initiativeOwners = new Map<string, string>();
  for (const [repoAlias, candidate] of Object.entries(candidateRepos)) {
    for (const initiativeId of boundInitiativeIds(candidate)) {
      const owner = initiativeOwners.get(initiativeId);
      if (owner) {
        throw new Error(
          `Linear initiative "${initiativeId}" would be registered to both "${owner}" and "${repoAlias}". ` +
            "Each initiative must belong to exactly one repo.",
        );
      }
      initiativeOwners.set(initiativeId, repoAlias);
    }
  }

  const configPath = writeGlobalConfig({ repos: { [alias]: entry }, removeRepos }, options.home);
  deps.log(`  wrote ${configPath}`);
  deps.log(`  ${style("green", "✓")} registered "${alias}" → ${repoRoot}`);
  const nameList = bindings
    .map((binding) => (typeof binding === "string" ? binding : binding.id))
    .map((id) => picked.names.get(id) ?? id);
  deps.log(`  bound initiative(s): ${nameList.join(", ")}`);

  printSection(deps.log, "Next step");
  deps.log("  foreman repo --dry-run --once");
}