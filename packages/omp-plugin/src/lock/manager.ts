/**
 * Lock claim/release primitives (SPEC §11). The `task-guard` interceptor is
 * the only caller of `claim` — agents never touch the lock. `release` runs
 * when a yield is consumed; this module exposes the operation for both the
 * result appliers and the commands, which release from Linear state rather
 * than from an already-fetched `Issue`.
 */

import type { Issue, LinearWriter, LockRecord } from "@foreman/core";
import { AGENT_LABEL, encodeMarker, MARKER_KIND, renderLockComment } from "@foreman/core";

/** Why a lock was released, for the release comment's benefit only. */
export type LockReleaseOutcome = "applied" | "blocked" | "orphan-reaped";

export async function claim(
  linear: LinearWriter,
  issue: Issue,
  agent: string,
  dispatchId: string,
  worktree: string | null,
  now: Date,
  ttlMs: number,
): Promise<void> {
  const runningLabel = await linear.ensureLabel(AGENT_LABEL.running, issue.team.id);
  await linear.updateIssue(issue.id, { addedLabelIds: [runningLabel.id] });
  const record: LockRecord = {
    dispatchId,
    agent,
    issueId: issue.identifier,
    takenAt: now.toISOString(),
    ttlMs,
    worktree,
    released: false,
    releasedAt: null,
  };
  await linear.createComment({ issueId: issue.id, body: renderLockComment(record) });
}

/**
 * Removes `agent:running` and writes a release note. `outcome` is recorded
 * in the release comment for the operator's benefit; it never changes the
 * mechanics of the release itself.
 */
export async function release(
  linear: LinearWriter,
  issueId: string,
  dispatchId: string,
  outcome: LockReleaseOutcome,
  now: Date = new Date(),
): Promise<void> {
  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return;

  const runningLabel = issue.labels.find((label) => label.name === AGENT_LABEL.running);
  if (runningLabel) {
    await linear.updateIssue(issue.id, { removedLabelIds: [runningLabel.id] });
  }

  const releaseNote = encodeMarker(
    MARKER_KIND.lock,
    { dispatchId, releasedAt: now.toISOString(), outcome },
    `Dispatch \`${dispatchId}\` released (${outcome}) at ${now.toISOString()}.`,
  );
  await linear.createComment({ issueId: issue.id, body: releaseNote });
}
