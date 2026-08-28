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
import { GitHubClient, LinearClient, loadGlobalConfig, lockTtlMs, resolveLinearApiKey } from "@foreman/core";

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
    linear = new LinearClient({
      apiKey,
      endpoint: config.linear.endpoint,
      teamKeys: config.linear.teamKeys,
    });
  } catch {
    missingApiKey = true;
  }

  runtime = {
    config,
    linear,
    github: new GitHubClient(),
    lockTtlMs: lockTtlMs(config),
    stateCache: new Map(),
    contextDigestCache: new Map(),
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

/** Throws when the API key was unresolvable — callers surface this as a tool-level error, not a crash. */
export function getLinear(): LinearWriter {
  const linear = requireRuntime().linear;
  if (!linear) {
    throw new Error(
      "No Linear API key resolved. Set the env var named by linear.apiKeyEnv or linear.apiKeyFile in .foreman/config.json.",
    );
  }
  return linear;
}

export function getGitHub(): GitHubClient {
  return requireRuntime().github;
}

export function getLockTtlMs(): number {
  return requireRuntime().lockTtlMs;
}

export async function getTeamStates(teamId: string): Promise<WorkflowState[]> {
  const rt = requireRuntime();
  const cached = rt.stateCache.get(teamId);
  if (cached) return cached;
  const states = await getLinear().workflowStates(teamId);
  rt.stateCache.set(teamId, states);
  return states;
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
    const digest = "## Product Context\n_project not found_\n\n## Project Brief\n_project not found_";
    rt.contextDigestCache.set(projectId, digest);
    return digest;
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
}
