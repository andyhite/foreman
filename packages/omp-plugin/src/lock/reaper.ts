/**
 * Lock reaper (SPEC §11). Sweeps `IN_FLIGHT_FILTER`, classifies each lock
 * comment with `lockState`, and for a genuinely orphaned lock clears
 * `agent:running` and comments what was found. Never deletes a worktree —
 * report and let the operator decide.
 */

import type { FoundMarker, Issue, LinearWriter, LockRecord } from "@foreman/core";
import { AGENT_LABEL, BLOCKED_LABEL, IN_FLIGHT_FILTER, encodeMarker, isTerminal, lockState, MARKER_KIND, readLockComment } from "@foreman/core";

export interface ReapedLock {
  issueId: string;
  dispatchId: string;
  agent: string;
  takenAt: string;
  worktree: string | null;
}

async function clearOrphanedLock(
  linear: LinearWriter,
  issue: Issue,
  found: FoundMarker<LockRecord>,
  now: Date,
): Promise<ReapedLock> {
  const runningLabel = issue.labels.find((label) => label.name === AGENT_LABEL.running);
  const removedLabelIds = runningLabel ? [runningLabel.id] : [];
  // Releasing the lock is the whole point of the sweep and happens either
  // way. Raising `blocked:needs-input` does not: a completed or canceled
  // issue has no decision left to make, and that label's queue is the
  // loop's backpressure signal (SPEC §17.7) — parking dead work in it
  // would stop every worker with nothing for the operator to resolve.
  const terminal = isTerminal(issue.state);
  const needsInputLabel = terminal ? null : await linear.ensureLabel(BLOCKED_LABEL.needsInput, issue.team.id);
  await linear.updateIssue(issue.id, {
    addedLabelIds: needsInputLabel ? [needsInputLabel.id] : [],
    removedLabelIds,
  });

  const body = encodeMarker(
    MARKER_KIND.lock,
    { dispatchId: found.data.dispatchId, reapedAt: now.toISOString() },
    [
      `Reaped an orphaned lock: dispatch \`${found.data.dispatchId}\` (\`${found.data.agent}\`), taken at ${found.data.takenAt}.`,
      found.data.worktree
        ? `Worktree left in place for inspection: \`${found.data.worktree}\`.`
        : "No worktree was recorded.",
      ...(terminal
        ? [`Issue is already ${issue.state.name}; the lock was released without raising a decision.`]
        : []),
    ].join("\n"),
  );
  await linear.createComment({ issueId: issue.id, body });

  return {
    issueId: issue.identifier,
    dispatchId: found.data.dispatchId,
    agent: found.data.agent,
    takenAt: found.data.takenAt,
    worktree: found.data.worktree,
  };
}

/**
 * Queries `IN_FLIGHT_FILTER`, reads each lock comment, and classifies it
 * against `liveDispatchIds` — the union of omp's process-global registry and
 * the loop's bookkeeping (SPEC §11) — cleaning up only what is genuinely
 * orphaned: unreleased, past TTL, and recognized by no liveness source.
 */
export async function sweep(
  linear: LinearWriter,
  now: Date = new Date(),
  liveDispatchIds: readonly string[] = [],
): Promise<ReapedLock[]> {
  let viewerId: string | null;
  try {
    viewerId = await linear.viewerId();
  } catch {
    viewerId = null;
  }
  // Without a viewer id we cannot tell our lock markers from forged ones —
  // same fail-closed posture as `checkLockFree` in the task guard.
  if (viewerId === null) return [];

  const issues = await linear.issues({ filter: IN_FLIGHT_FILTER, includeComments: true });
  const reaped: ReapedLock[] = [];

  for (const issue of issues) {
    const found = readLockComment(issue.comments, viewerId);
    if (!found) continue;
    const state = lockState(found.data, { now, liveDispatchIds });
    if (!state.orphaned) continue;
    reaped.push(await clearOrphanedLock(linear, issue, found, now));
  }

  return reaped;
}
