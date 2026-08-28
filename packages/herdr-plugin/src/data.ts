/**
 * Every Linear read the board's screens need (SPEC §17.4). The board caches
 * nothing authoritative and holds no queue of its own — every function here
 * re-reads Linear (or the loop's non-authoritative bookkeeping file) on call,
 * and callers hold at most a per-frame in-memory snapshot.
 *
 * Credentials come from `HERDR_PLUGIN_CONFIG_DIR`, never the managed plugin
 * checkout, because a reinstall replaces the checkout but not the config dir
 * (SPEC §17.4). `resolveLinearApiKey` already prefers the env var, so this
 * only has to default `linear.apiKeyFile` when it isn't set explicitly.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKED_HUMAN_FILTER,
  type BlockRecord,
  type Comment,
  expandHome,
  findMarkers,
  type GlobalConfig,
  type Issue,
  latestMarker,
  LinearClient,
  loadGlobalConfig,
  PROPOSALS_FILTER,
  resolveLinearApiKey,
  type TriageItem,
} from "@foreman/core";

/** One `BlockRecord`, its owning issue, and the comment it came from. */
export interface BlockedEntry {
  issue: Issue;
  record: BlockRecord;
  commentId: string;
}

/** One triage proposal item still awaiting approval or rejection. */
export interface ProposalEntry {
  issue: Issue;
  item: TriageItem;
  commentId: string;
}

/**
 * `stage: string` — the loop's bookkeeping shape is still landing on core, so
 * this reads defensively and returns null fields for anything absent rather
 * than throwing. See `BoardData.lastRunAt` for the field this awaits.
 */
export interface LoopBookkeeping {
  lastRunAt: Partial<Record<"triage" | "refine" | "implement" | "review", string | null>>;
  attempts: Record<string, { count: number; lastAttemptAt: string }>;
  pendingDecisions: Array<{ issueId: string; stage: string; kind: string; attempts: number }>;
}

const EMPTY_BOOKKEEPING: LoopBookkeeping = { lastRunAt: {}, attempts: {}, pendingDecisions: [] };

/**
 * Resolves the global config with the board's config-dir override for
 * `linear.apiKeyFile` applied before validation, then builds a `LinearClient`
 * from it. `HERDR_PLUGIN_CONFIG_DIR` is set by the herdr runtime for every
 * plugin process (SPEC §17.4 runtime env list).
 */
export function loadBoardConfig(env: Record<string, string | undefined> = process.env): GlobalConfig {
  const pluginConfigDir = env.HERDR_PLUGIN_CONFIG_DIR;
  const { config } = loadGlobalConfig({ env });
  if (pluginConfigDir && config.linear.apiKeyFile === null) {
    config.linear.apiKeyFile = join(pluginConfigDir, "linear-token");
  }
  return config;
}

/**
 * Resolves the single team key to scope the board's `LinearClient` to, per
 * SPEC §17.4: the board is "one view over the whole team." `config.repos`
 * entries carry an optional `team` (SPEC §3.10) — when every entry that
 * names one agrees, that is unambiguously the operator's team; when they
 * disagree, or none names one, the client is left unscoped rather than
 * guessing (falls back to the client's own single-team resolution, SPEC
 * §3.11's `resolveTeamKey`, which the board does not have the async Linear
 * read to perform here).
 */
function resolveBoardTeamKey(config: GlobalConfig): string | null {
  const teams = new Set(
    Object.values(config.repos)
      .map((entry) => entry.team)
      .filter((team): team is string => typeof team === "string"),
  );
  return teams.size === 1 ? [...teams][0]! : null;
}

export function buildLinearClient(
  config: GlobalConfig,
  env: Record<string, string | undefined> = process.env,
): LinearClient {
  return new LinearClient({
    apiKey: resolveLinearApiKey(config, env),
    endpoint: config.linear.endpoint,
    team: resolveBoardTeamKey(config),
  });
}

/** SPEC §17.4 blocked drain: every issue in the Blocked (human) view with its parsed `BlockRecord`. */
export async function fetchBlockedEntries(client: LinearClient): Promise<BlockedEntry[]> {
  const issues = await client.issues({ filter: BLOCKED_HUMAN_FILTER, includeComments: true, limit: 200 });
  const entries: BlockedEntry[] = [];
  for (const issue of issues) {
    const marker = latestBlockMarker(issue.comments);
    if (marker) entries.push({ issue, record: marker.data, commentId: marker.commentId });
  }
  return entries;
}

/**
 * The newest `foreman:block` marker on the issue. A malformed marker (JSON
 * that parses but fails the `BlockRecord` shape, e.g. missing a required
 * field) is skipped rather than crashing the screen — `decodeMarker` already
 * skips non-JSON and wrong-kind fences; this adds a shape check on top since
 * the marker payload is untyped JSON at the trust boundary.
 */
function latestBlockMarker(comments: readonly Comment[]): { commentId: string; data: BlockRecord } | null {
  const markers = findMarkers<unknown>("block", comments);
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const marker = markers[i];
    if (marker && isBlockRecord(marker.data)) {
      return { commentId: marker.commentId, data: marker.data };
    }
  }
  return null;
}

function isBlockRecord(value: unknown): value is BlockRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.blocked === true &&
    typeof record.type === "string" &&
    typeof record.whatIWasDoing === "string" &&
    typeof record.whatINeed === "string" &&
    typeof record.costOfWrongGuess === "string" &&
    typeof record.stateLeftBehind === "object" &&
    record.stateLeftBehind !== null
  );
}

/**
 * SPEC §17.4 proposal review: every `agent:proposed` issue's latest
 * `foreman:proposal` marker, excluding any already applied — a later
 * `foreman:applied` marker on the same issue means `/foreman-apply` already
 * ran, so it must not show up in the batch again.
 */
export async function fetchProposalEntries(client: LinearClient): Promise<ProposalEntry[]> {
  const issues = await client.issues({ filter: PROPOSALS_FILTER, includeComments: true, limit: 200 });
  const entries: ProposalEntry[] = [];
  for (const issue of issues) {
    const proposal = latestMarker<TriageItem>("proposal", issue.comments);
    if (!proposal) continue;
    const applied = latestMarker<unknown>("applied", issue.comments);
    if (applied && applied.createdAt > proposal.createdAt) continue;
    entries.push({ issue, item: proposal.data, commentId: proposal.commentId });
  }
  return entries;
}

/**
 * Reads the loop's bookkeeping read-only and aggregates it across every
 * registry alias (SPEC §17.4 board screen: "last run per worker from the
 * loop's bookkeeping file"). State is per-instance now — one `foreman loop`
 * per repo, one bookkeeping file at
 * `<stateDir>/<alias>/bookkeeping.json` (SPEC §3.11, §17.5) — but the board
 * is "one view over the whole team" (§17.4), so it reads every alias's file
 * and merges them rather than picking one. A missing file for a given alias
 * — that instance has never run, or hasn't written yet — is not an error:
 * it contributes nothing to the merge.
 */
export function readLoopBookkeeping(config: GlobalConfig): LoopBookkeeping {
  const merged: LoopBookkeeping = { lastRunAt: {}, attempts: {}, pendingDecisions: [] };
  for (const alias of Object.keys(config.repos)) {
    const single = readAliasBookkeeping(config, alias);
    for (const [stage, at] of Object.entries(single.lastRunAt)) {
      const key = stage as keyof LoopBookkeeping["lastRunAt"];
      const existing = merged.lastRunAt[key];
      if (at && (!existing || at > existing)) merged.lastRunAt[key] = at;
    }
    for (const [issueId, attempt] of Object.entries(single.attempts)) {
      const existing = merged.attempts[issueId];
      if (!existing || attempt.lastAttemptAt > existing.lastAttemptAt) merged.attempts[issueId] = attempt;
    }
    merged.pendingDecisions.push(...single.pendingDecisions);
  }
  return merged;
}

/** Reads one instance's bookkeeping file (SPEC §3.11 per-alias state dir). */
function readAliasBookkeeping(config: GlobalConfig, alias: string): LoopBookkeeping {
  const path = join(expandHome(config.loop.stateDir), alias, "bookkeeping.json");
  if (!existsSync(path)) return EMPTY_BOOKKEEPING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return EMPTY_BOOKKEEPING;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_BOOKKEEPING;
  const raw = parsed as Record<string, unknown>;
  const lastRunAt =
    typeof raw.lastRunAt === "object" && raw.lastRunAt !== null && !Array.isArray(raw.lastRunAt)
      ? (raw.lastRunAt as LoopBookkeeping["lastRunAt"])
      : {};
  const attempts =
    typeof raw.attempts === "object" && raw.attempts !== null && !Array.isArray(raw.attempts)
      ? (raw.attempts as LoopBookkeeping["attempts"])
      : {};
  const pendingDecisions = Array.isArray(raw.pendingDecisions)
    ? (raw.pendingDecisions as LoopBookkeeping["pendingDecisions"])
    : [];
  return { lastRunAt, attempts, pendingDecisions };
}

/**
 * SPEC §17.4 board screen: issues grouped by workflow state name, for the
 * ambient board. Team scoping lives in the client (`linear.team`, resolved by
 * `resolveBoardTeamKey` above), so this no longer builds its own — one
 * filter, applied to every read.
 */
export async function fetchIssuesByState(client: LinearClient): Promise<Issue[]> {
  return client.issues({ limit: 500 });
}
