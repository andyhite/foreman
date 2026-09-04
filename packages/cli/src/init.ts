/**
 * `foreman init` — registers the current repo as an entry in the global
 * `config.repos` registry, and activates Foreman's omp plugin for that repo
 * (SPEC §3.10, §3.11).
 *
 * Unlike `foreman setup` (tool preflight, the Linear key, the global plugin
 * link), this runs *inside* a target repo and only ever touches that repo's
 * own registry entry plus its own project-scoped plugin activation: no
 * preflight, no key prompt/write (it reads whatever `foreman setup` already
 * configured). Running it a second time for the same repo updates the
 * existing registry entry instead of creating a duplicate, which is how a
 * monorepo grows a second bound initiative over time, and leaves an
 * already-activated plugin alone.
 *
 * Activation itself is just two files (`plugin-activation.ts`'s job): a
 * lock entry and a symlink to `~/.foreman/plugin`, the global indirection
 * `foreman setup` points at a checkout. No `omp` subprocess is ever
 * invoked — omp discovers a project plugin root by walking the filesystem,
 * so writing the files it expects is activation; there is nothing to
 * install or ask omp about.
 */

import {
  activateRepoPlugin,
  type AppBinding,
  type CommandRunner,
  ConfigError,
  ensureGitExclude,
  GitHubAppAuth,
  GitHubClient,
  LinearApiError,
  LinearClient,
  PLUGIN_PACKAGE_NAME,
  expandHome,
  loadGlobalConfig,
  provisionTeam,
  resolveGitHubAppCredentials,
  resolveLinearApiKey,
  type GlobalConfig,
  type RepoEntry,
  teamIndex,
  type TeamRef,
} from "@foreman/core";
import { basename } from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "./global-config.ts";
import type { Prompter } from "./prompt.ts";
import { promptConfirmer, printProvisionActions } from "./provision-report.ts";
import { printSection, style } from "./tui.ts";

export interface InitOptions {
  /** Directory being registered; the git repo root is resolved from it. */
  cwd: string;
  home: string;
  /** Skip Linear entirely: no team prompt against the API, no provisioning. */
  skipLinear: boolean;
  /** Skip activating the omp plugin for this repo. */
  skipPlugin: boolean;
  /** Non-interactive app bindings (app names). */
  apps?: string[];
  /** Non-interactive registry alias override. */
  alias?: string;
  /** Non-interactive Linear team key. */
  team?: string;
  /** True when no prompt can be answered by a human: `--yes` or non-TTY stdin. */
  nonInteractive?: boolean;
}

export interface InitDeps {
  prompter: Prompter;
  log: (message: string) => void;
  /** `nodeRunner` from `@foreman/core`; captures stdout, unlike cli's own `Runner`. */
  git: CommandRunner;
  /** Best-effort browser opener for the GitHub App install link; omitted in non-interactive runs. */
  openUrl?: (url: string) => void;
}

/** Parses `--app <name>`. */
function parseAppArg(raw: string): AppBinding {
  const name = raw.trim();
  if (name.length === 0) throw new Error(`Invalid --app "${raw}": app name is required.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid --app "${raw}": app names are lowercase alphanumeric with hyphens.`);
  }
  return { name };
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
    return resolveLinearApiKey(config, process.env, options.home);
  } catch {
    return null;
  }
}

/**
 * Resolves the Linear team key for this repo: `--team` first, then an
 * API-backed select (hinting a team already bound to a *different* alias —
 * `assertTeamsUnique` rejects that combination at load time, so this warns
 * at the prompt instead of letting the operator write a config that won't
 * load), then a manual text prompt, then a hard failure. Never returns "".
 */
async function resolveTeam(
  deps: InitDeps,
  options: InitOptions,
  apiKey: string | null,
  existingEntry: RepoEntry | null,
  boundElsewhere: Record<string, string>,
): Promise<string> {
  if (options.team !== undefined) {
    const team = options.team.trim();
    if (team.length === 0) {
      throw new ConfigError("A Linear team is required", [
        "pass --team <KEY>, or run `foreman setup` to configure a Linear credential",
      ]);
    }
    if (apiKey) {
      try {
        const client = new LinearClient({ apiKey });
        const teams: TeamRef[] = await client.teams();
        if (teams.length > 0 && !teams.some((candidate) => candidate.key === team)) {
          throw new ConfigError(`Linear team "${team}" does not exist in this workspace`, [
            `available teams: ${teams.map((candidate) => candidate.key).join(", ") || "(none)"}`,
          ]);
        }
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        const message = error instanceof LinearApiError ? error.message : String(error);
        deps.log(`  ${style("yellow", "!")} couldn't reach the Linear API (${message}) — skipping team validation.`);
      }
    }
    return team;
  }

  const defaultTeam = existingEntry?.team ?? "";

  if (apiKey) {
    const client = new LinearClient({ apiKey });
    try {
      const teams: TeamRef[] = await client.teams();
      if (teams.length > 0) {
        const sorted = [...teams].sort((a, b) => a.key.localeCompare(b.key));
        const choices = sorted.map((team) => {
          const owner = boundElsewhere[team.key.toLowerCase()];
          const hint = owner ? ` (bound to repos.${owner})` : "";
          return { value: team.key, label: `${team.key} — ${team.name}${hint}` };
        });
        const fallbackDefault = defaultTeam.length > 0 ? defaultTeam : (sorted[0]?.key ?? "");
        const selected = await deps.prompter.select("Linear team for this repo", choices, fallbackDefault);
        const team = selected.trim();
        if (team.length === 0) {
          throw new ConfigError("A Linear team is required", [
            "pass --team <KEY>, or run `foreman setup` to configure a Linear credential",
          ]);
        }
        return team;
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      const message = error instanceof LinearApiError ? error.message : String(error);
      deps.log(`  ${style("yellow", "!")} couldn't reach the Linear API (${message}) — falling back to manual entry.`);
    }
  }

  const team = (await deps.prompter.text("Linear team key for this repo", defaultTeam)).trim();
  if (team.length === 0) {
    throw new ConfigError("A Linear team is required", [
      "pass --team <KEY>, or run `foreman setup` to configure a Linear credential",
    ]);
  }
  return team;
}

/** Non-interactive `--app` values, or one comma-separated prompt. Blank input omits `apps` entirely. */
async function resolveApps(deps: InitDeps, options: InitOptions, existingEntry: RepoEntry | null): Promise<AppBinding[]> {
  if (options.apps !== undefined) return options.apps.map(parseAppArg);

  const existing = existingEntry?.apps ?? [];
  const namesInput = await deps.prompter.text(
    "Apps in this repo (comma-separated, blank for a single-app repo)",
    existing.map((app) => app.name).join(", "),
  );
  const names = namesInput
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return [];

  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`Invalid app name "${name}": app names are lowercase alphanumeric with hyphens.`);
    }
  }
  return names.map((name) => ({ name }));
}

/**
 * Provisions this repo's Linear team — triage on, cycles off, the nine
 * managed workflow states, and `app:*` labels for its configured apps.
 * Mirrors `wizard.ts`'s `provisionLabels`: skipped without a credential,
 * failures print and defer to `foreman doctor --fix` rather than failing init.
 */
async function provisionTeamForRepo(
  deps: InitDeps,
  apiKey: string,
  team: string,
  appNames: readonly string[],
): Promise<boolean> {
  printSection(deps.log, "Linear team provisioning");

  const client = new LinearClient({ apiKey });
  const teams = await client.teams();
  const matched = teams.find((candidate) => candidate.key === team);
  if (!matched) {
    throw new ConfigError(`Linear team "${team}" does not exist in this workspace`, [
      `available teams: ${teams.map((candidate) => candidate.key).join(", ") || "(none)"}`,
    ]);
  }

  const confirmer = promptConfirmer(deps.prompter, deps.log);

  const actions = await provisionTeam(client, { teamId: matched.id, apps: appNames, confirmer });
  const failed = printProvisionActions(deps.log, actions);
  return failed;
}

/** `origin/HEAD`'s branch, then the current branch, then `fallback` (a repo with no commits has neither). */
async function detectBaseBranch(repoRoot: string, git: CommandRunner, fallback: string): Promise<string> {
  try {
    const { stdout } = await git.run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoRoot,
    });
    const ref = stdout.trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  } catch {
    try {
      const { stdout } = await git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
      return stdout.trim();
    } catch {
      return fallback;
    }
  }
}

/**
 * Activates Foreman's omp plugin for `repoRoot`, run once the registry entry
 * above has already been written successfully. A failed or skipped
 * activation never rolls that back — the operator can always activate the
 * plugin by hand later (or fix `~/.foreman/plugin` and re-run), but a repo
 * that failed to register at all has nothing to activate into.
 */
function activateProjectPlugin(deps: InitDeps, options: InitOptions, repoRoot: string): void {
  printSection(deps.log, "omp plugin (this repo only)");

  if (options.skipPlugin) {
    deps.log("  skipped (--skip-plugin).");
    return;
  }

  try {
    const result = activateRepoPlugin(repoRoot, options.home);
    deps.log(
      result.linkChanged
        ? `  ${style("green", "✓")} linked ${result.linkPath} → ${result.target}`
        : `  ${style("cyan", "i")} already linked: ${result.linkPath} → ${result.target}`,
    );
    deps.log(
      result.lockChanged
        ? `  ${style("green", "✓")} recorded "${PLUGIN_PACKAGE_NAME}" v${result.version} in ${result.lockPath}`
        : `  ${style("cyan", "i")} lock entry for "${PLUGIN_PACKAGE_NAME}" v${result.version} already up to date.`,
    );
    deps.log(
      result.installedPluginsChanged
        ? `  ${style("green", "✓")} namespaced slash commands under "foreman:" in ${result.installedPluginsPath}`
        : `  ${style("cyan", "i")} "foreman:" command namespace in ${result.installedPluginsPath} already up to date.`,
    );
  } catch (error) {
    deps.log(
      `  ${style("yellow", "!")} ${error instanceof Error ? error.message : String(error)} The repo is still ` +
        "registered above; run `foreman setup` then `foreman init` again once the global link exists.",
    );
    return;
  }

  // `.omp/plugins/` holds a machine-local symlink (it points at this
  // machine's `~/.foreman/plugin`), so it is excluded per-clone via
  // `.git/info/exclude` rather than the repo's tracked `.gitignore` — every
  // other clone of this repo needs its own exclusion, not this one's.
  const excludeResult = ensureGitExclude(repoRoot);
  if (excludeResult?.changed) {
    deps.log(`  ${style("green", "✓")} excluded .omp/plugins/ in ${excludeResult.path} (machine-local, not tracked).`);
  }
}

/**
 * Non-blocking check that the configured GitHub App (if any) is installed
 * on this repo — installing an App only ever happens through GitHub's own
 * UI, never the API, so this can only check and point at the install page,
 * never automate the install itself (SPEC §7.4). Auto-opening that page is
 * itself asked for: an operator may run `foreman init` for a repo it
 * deliberately doesn't want `foreman-review` posting real GitHub reviews
 * on, and a browser tab popping open unasked would be the tool assuming
 * that decision for them.
 */
async function checkGitHubAppInstall(deps: InitDeps, options: InitOptions, repoRoot: string): Promise<void> {
  let credentials;
  try {
    const { config } = loadGlobalConfig({ home: options.home });
    credentials = resolveGitHubAppCredentials(config, options.home);
  } catch {
    return;
  }
  if (!credentials) return;

  printSection(deps.log, "GitHub App");
  const github = new GitHubClient({ runner: deps.git });
  let slug: { owner: string; repo: string };
  try {
    slug = await github.repoSlug(repoRoot);
  } catch {
    deps.log(`  ${style("yellow", "!")} couldn't resolve this repo's GitHub owner/name (is \`gh\` authenticated here?) — skipping the install check.`);
    return;
  }

  const auth = new GitHubAppAuth(credentials);
  try {
    if (await auth.installationExists(slug.owner, slug.repo)) {
      deps.log(`  ${style("green", "✓")} installed on ${slug.owner}/${slug.repo} — foreman-review can submit real PR reviews here.`);
      return;
    }
    const app = await auth.app();
    const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    deps.log(`  ${style("yellow", "!")} not installed on ${slug.owner}/${slug.repo} — install it: ${installUrl}`);
    if (deps.openUrl) {
      const shouldOpen = await deps.prompter.confirm(`Open that install page in your browser now?`, true);
      if (shouldOpen) {
        deps.log(`  ${style("cyan", "i")} opening that link in your browser…`);
        deps.openUrl(installUrl);
      }
    }
  } catch (error) {
    deps.log(`  ${style("yellow", "!")} couldn't verify the GitHub App installation (${error instanceof Error ? error.message : String(error)}).`);
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
  if (options.team === undefined && options.nonInteractive && existingEntry?.team === undefined) {
    throw new ConfigError("A Linear team is required", [
      "pass --team <KEY>, or run `foreman init` from an interactive terminal",
    ]);
  }

  // Every team already bound to a *different* alias, lowercased for the
  // select prompt's case-insensitive hint — `assertTeamsUnique` rejects the
  // collision at load/write time regardless, this just warns earlier.
  const boundElsewhere: Record<string, string> = {};
  for (const [teamKey, otherAlias] of Object.entries(teamIndex({ repos: existing.repos } as GlobalConfig))) {
    if (otherAlias === alias || otherAlias === existingByPath?.alias) continue;
    boundElsewhere[teamKey.toLowerCase()] = otherAlias;
  }

  const apiKey = await resolveConfiguredApiKey(options);
  const team = await resolveTeam(deps, options, apiKey, existingEntry, boundElsewhere);
  const apps = await resolveApps(deps, options, existingEntry);

  const baseBranch = await detectBaseBranch(repoRoot, deps.git, existing.effectiveBaseBranch);

  const entry: RepoEntry = {
    path: repoRoot,
    team,
    ...(apps.length > 0 ? { apps } : {}),
    // Writing today's inherited default back out would pin it forever the
    // next time repoDefaults.baseBranch changes underneath an untouched
    // entry — see global-config.ts's header comment. So the entry only
    // records baseBranch when the repo's real default branch differs from
    // what it would otherwise inherit from repoDefaults.
    ...(baseBranch !== existing.effectiveBaseBranch ? { baseBranch } : {}),
  };

  const removeRepos = existingByPath && existingByPath.alias !== alias ? [existingByPath.alias] : [];

  const configPath = writeGlobalConfig({ repos: { [alias]: entry }, removeRepos }, options.home);
  deps.log(`  wrote ${configPath}`);
  deps.log(`  ${style("green", "✓")} registered "${alias}" → ${repoRoot}`);
  deps.log(`  team: ${team}`);
  deps.log(`  app(s): ${apps.length > 0 ? apps.map((app) => app.name).join(", ") : "(none — single-app repo)"}`);

  activateProjectPlugin(deps, options, repoRoot);

  await checkGitHubAppInstall(deps, options, repoRoot);

  let provisioningFailed = false;
  if (options.skipLinear) {
    printSection(deps.log, "Linear team provisioning");
    deps.log("  skipped (--skip-linear).");
  } else {
    const provisionKey = apiKey ?? (await resolveConfiguredApiKey({ ...options, skipLinear: false }));
    if (!provisionKey) {
      printSection(deps.log, "Linear team provisioning");
      deps.log("  skipped, no Linear credential — run `foreman setup` to configure one.");
    } else {
      try {
        provisioningFailed = await provisionTeamForRepo(
          deps,
          provisionKey,
          team,
          apps.map((app) => app.name),
        );
      } catch (error) {
        deps.log(`  ${style("yellow", "!")} team provisioning failed: ${(error as Error).message}`);
        provisioningFailed = true;
      }
    }
  }

  printSection(deps.log, "Next step");
  deps.log(`  foreman plan ${alias} --once`);
  deps.log(`  foreman build ${alias} --once`);
  deps.log("  foreman doctor");
  if (provisioningFailed) {
    deps.log(`  ${style("yellow", "!")} some Linear provisioning steps weren't applied; re-run \`foreman doctor --fix\` to retry.`);
  }
}