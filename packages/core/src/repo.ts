import { ConfigError } from "./config/load.ts";
import type { ResolvedRepoEntry } from "./config/load.ts";
import type { Issue } from "./linear/types.ts";

/**
 * Why an issue is out of an instance's scope. The loop skips on this; a
 * manual command refuses and names the reason.
 */
export type OutOfScopeReason = "team-mismatch";

export interface ScopeVerdict {
  inScope: boolean;
  reason: OutOfScopeReason | null;
  message: string | null;
}

/**
 * Decides whether `issue` belongs to this instance: its team must match the
 * entry's bound team. Pure and synchronous — team membership is on the issue
 * already, so this makes no Linear call.
 */
export function issueScope(entry: ResolvedRepoEntry, issue: Issue): ScopeVerdict {
  if (issue.team.key.toLowerCase() !== entry.team.toLowerCase()) {
    return {
      inScope: false,
      reason: "team-mismatch",
      message: `Issue ${issue.identifier} belongs to team ${issue.team.key}, not repos.${entry.alias}'s team ${entry.team}`,
    };
  }

  return { inScope: true, reason: null, message: null };
}

/**
 * `issueScope`, but for the manual commands: an out-of-scope issue is
 * operator error there, not a routine skip, so it throws with the reason
 * rather than returning a verdict to ignore.
 */
export function assertIssueInScope(entry: ResolvedRepoEntry, issue: Issue): void {
  const verdict = issueScope(entry, issue);
  if (!verdict.inScope) {
    throw new ConfigError(verdict.message ?? `Issue ${issue.identifier} is out of scope`, [
      `repos.${entry.alias} binds team ${entry.team}`,
    ]);
  }
}
