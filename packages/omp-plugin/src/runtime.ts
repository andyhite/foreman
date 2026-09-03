/**
 * Lazily-initialized process-wide holder for config, the `LinearClient`, the
 * `GitHubClient`, and derived values (lock TTL, per-team resolved states, a
 * Context-doc digest cache).
 *
 * Built on first use, rebuilt on `session_start`. Never constructed at module
 * load: an omp extension module runs at load time for every session,
 * including sessions in a repo with no Foreman config at all, so eagerly
 * constructing a Linear client here would throw before the extension ever
 * gets to decide that a missing API key is a loud notification rather than a
 * load-time crash (SPEC §3.5 item 6).
 */

import type { GlobalConfig, Initiative, LinearWriter, Project, WorkflowState } from "@foreman/core";
import type { ResolvedRepoEntry } from "@foreman/core";
import {
  ConfigError,
  entryForCwd,
  GitHubAppAuth,
  GitHubClient,
  LinearClient,
  loadGlobalConfig,
  lockTtlMs,
  resolveGitHubAppCredentials,
  resolveLinearApiKey,
} from "@foreman/core";

/** Thrown by any accessor called before `initRuntime` has run at least once. */
export class ExtensionRuntimeNotInitializedError extends Error {
  constructor() {
    super("Foreman runtime accessed before initialization. Call initRuntime() from session_start first.");
    this.name = "ExtensionRuntimeNotInitializedError";
  }
}

export interface RuntimeInitResult {
  ok: boolean;
  /** Set when config loaded but no Linear API key was resolvable — a legitimate state outside a Foreman repo. */
  missingApiKey: boolean;
  warnings: string[];
}

interface Runtime {
  config: GlobalConfig;
  linear: LinearWriter | null;
  github: GitHubClient;
  lockTtlMs: number;
  stateCache: Map<string, WorkflowState[]>;
  contextDigestCache: Map<string, string>;
  /** Memoized by `getEntry()` on first access — `entryForCwd` throws `ConfigError` on an unregistered cwd, so it must not run eagerly in `initRuntime` (SPEC §3.5 item 6, mirroring the Linear client's lazy construction above). */
  entry: ResolvedRepoEntry | null;
}

const activeDispatchIds = new Set<string>();

export function registerLiveDispatch(dispatchId: string): void {
  activeDispatchIds.add(dispatchId);
}

export function releaseLiveDispatch(dispatchId: string): void {
  activeDispatchIds.delete(dispatchId);
}

export function liveDispatchIds(): readonly string[] {
  return [...activeDispatchIds];
}

let runtime: Runtime | null = null;

function productDigest(initiative: Initiative | null): string {
  const doc = initiative?.documents.find((entry) => entry.title.trim().toLowerCase() === "context");
  const body = doc?.content?.trim();
  return `## Product Context (${initiative?.name ?? "unknown"})\n${body && body.length > 0 ? body : "_none_"}`;
}

/*
 * `content` is the project's document body — the `## Overview` an operator
 * actually writes, and what SPEC §4.7 means by the brief. `description` is
 * Linear's one-line summary; measured against the live workspace it is a
 * single truncated sentence, so it serves only as a fallback for a project
 * whose body is still empty.
 */
function projectBriefDigest(project: Project): string {
  const body = project.content?.trim() || project.description?.trim();
  return `## Project Brief (${project.name})\n${body && body.length > 0 ? body : "_none_"}`;
}

/** Rebuilds the runtime. Call from `session_start`; never throws on a missing API key. */
export function initRuntime(options?: { home?: string; env?: Record<string, string | undefined> }): RuntimeInitResult {
  const { config, warnings } = loadGlobalConfig(options);
  let linear: LinearWriter | null = null;
  let missingApiKey = false;
  try {
    const apiKey = resolveLinearApiKey(config, options?.env ?? process.env);
    // The team to scope the client to is `entryForCwd(config, cwd).team` (SPEC
    // §3.11). Resolving that entry here would make a missing/unregistered repo
    // fail `initRuntime` itself, which must never throw (see the module doc);
    // and when the entry has no `team`, SPEC §3.11's fallback is "the sole team
    // the credential can access", which is an async `teams()` call this sync
    // function cannot make. So: resolve the entry defensively, best-effort, and
    // leave the client unscoped (matching all teams) when there is no entry or
    // no entry team — `getEntry()` still throws its own `ConfigError` later for
    // any caller that actually needs the entry to exist.
    let team: string | null = null;
    try {
      team = entryForCwd(config, process.cwd(), options?.home).team;
    } catch {
      team = null;
    }
    linear = new LinearClient({
      apiKey,
      endpoint: config.linear.endpoint,
      team,
    });
  } catch {
    missingApiKey = true;
  }

  // App-authenticated review posting is entirely optional (SPEC §7.4) — a
  // misconfigured or unreadable key must degrade to the unconfigured
  // default (Linear-comment-only reviews), not break every session the way
  // a missing Linear key would if left uncaught above.
  let github: GitHubClient;
  try {
    const credentials = resolveGitHubAppCredentials(config, options?.home);
    github = new GitHubClient({ appAuth: credentials ? new GitHubAppAuth(credentials) : undefined });
  } catch (error) {
    warnings.push(`GitHub App not configured: ${error instanceof Error ? error.message : String(error)}`);
    github = new GitHubClient();
  }

  runtime = {
    config,
    linear,
    github,
    lockTtlMs: lockTtlMs(config),
    stateCache: new Map(),
    contextDigestCache: new Map(),
    entry: null,
  };

  return { ok: true, missingApiKey, warnings };
}

function requireRuntime(): Runtime {
  if (!runtime) throw new ExtensionRuntimeNotInitializedError();
  return runtime;
}

export function getConfig(): GlobalConfig {
  return requireRuntime().config;
}

/**
 * Memoized resolution of this instance's registry entry from `process.cwd()`
 * (SPEC §3.11). Throws `ConfigError` when cwd is not a registered repo —
 * callers that must tolerate an unregistered cwd (most repos never run
 * Foreman) should check `isRepoRegistered()` first.
 */
export function getEntry(): ResolvedRepoEntry {
  const rt = requireRuntime();
  if (!rt.entry) {
    rt.entry = entryForCwd(rt.config, process.cwd());
  }
  return rt.entry;
}

/**
 * True when `process.cwd()` (or `cwd`) falls inside a repo registered in
 * `~/.foreman/config.json`. Most repos never register with Foreman at all —
 * that is a normal, silent state, not an error — so any entry-dependent
 * behavior (the task guard, the session-start ensure pass) must check this
 * before calling `getEntry()` rather than treating its `ConfigError` as a
 * failure.
 */
export function isRepoRegistered(cwd: string = process.cwd()): boolean {
  const rt = requireRuntime();
  if (cwd === process.cwd() && rt.entry) return true;
  try {
    const entry = entryForCwd(rt.config, cwd);
    if (cwd === process.cwd()) rt.entry = entry;
    return true;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

/** Throws when the API key was unresolvable — callers surface this as a tool-level error, not a crash. */
export function getLinear(): LinearWriter {
  const linear = requireRuntime().linear;
  if (!linear) {
    throw new Error(
      "No Linear API key resolved. Set the env var named by linear.apiKeyEnv, or point linear.apiKeyFile at a file whose first line is the key, in ~/.foreman/config.json.",
    );
  }
  return linear;
}

export function getGitHub(): GitHubClient {
  return requireRuntime().github;
}


/**
 * Returns the cached two-layer Context digest for `projectId`, fetching and
 * caching it on first ask (SPEC §4.7): the product `Context` doc on the
 * project's initiative, concatenated product-first with the project's own
 * brief. Either layer degrades to a stub rather than throwing — a new
 * product with a stub `Context` doc, or a project with no brief yet, is a
 * legitimate state the digest must still render usefully. An unresolvable
 * initiative (the project belongs to zero or more than one — the gate is
 * what rejects dispatch for that, not the digest) degrades the product
 * layer the same way a missing document does.
 */
export async function getContextDigest(projectId: string): Promise<string> {
  const rt = requireRuntime();
  const cached = rt.contextDigestCache.get(projectId);
  if (cached) return cached;

  const linear = getLinear();
  const project = await linear.project(projectId);

  if (!project) {
    return "## Product Context\n_project not found_\n\n## Project Brief\n_project not found_";
  }

  let initiative: Initiative | null = null;
  try {
    const ref = await linear.projectInitiative(projectId);
    initiative = await linear.initiative(ref.id);
  } catch {
    initiative = null;
  }

  const digest = `${productDigest(initiative)}\n\n${projectBriefDigest(project)}`;
  rt.contextDigestCache.set(projectId, digest);
  return digest;
}

/** Test/session-teardown seam: forces the next accessor call to throw until `initRuntime` runs again. */
export function resetRuntime(): void {
  runtime = null;
  activeDispatchIds.clear();
}
