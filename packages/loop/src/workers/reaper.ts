/**
 * Lock reaper (SPEC §11): sweeps expired `agent:running` locks. Never deletes
 * a worktree — it reports what it found and flags it; the operator decides.
 */

import {
  AGENT_LABEL,
  BLOCKED_LABEL,
  IN_FLIGHT_FILTER,
  hasLabel,
  isTerminal,
  lockState,
  readLockComment,
  type BlockedItem,
  type FoundMarker,
  type LockRecord,
} from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

/** The stage a lock's `agent` field maps back to, for a skip/blocked entry's `stage`. */
function stageFor(record: FoundMarker<LockRecord> | null): "refine" | "review" | "plan" | "implement" {
  return record?.data.agent === "foreman-refine"
    ? "refine"
    : record?.data.agent === "foreman-review"
      ? "review"
      : record?.data.agent === "foreman-plan"
        ? "plan"
        : "implement";
}
async function runReaper(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const skipped: WorkerReport["skipped"] = [];
  const blocked: BlockedItem[] = [];

  let viewerId: string | null;
  try {
    viewerId = await ctx.linear.viewerId();
  } catch {
    viewerId = null;
  }

  const running = await ctx.linear.issues({ filter: IN_FLIGHT_FILTER, first: 250, includeComments: true });

  // Live dispatch ids: anything the loop itself started and has not yet
  // cleared from bookkeeping. This is deliberately non-authoritative (SPEC
  // §17.5) — a lock absent from here but present in the omp registry (which
  // this process cannot see across a restart) is still only reported, not
  // force-cleared, unless it is also past TTL.
  const liveDispatchIds = new Set(ctx.bookkeeping.state.inFlight.map((entry) => entry.dispatchId));

  for (const issue of running) {
    if (!hasLabel(issue, AGENT_LABEL.running)) continue;
    // Authorship unverifiable (`viewerId` unavailable): fail closed — treat
    // every lock marker as untrusted, so a forged release is never honored
    // and this lock is reported rather than reclaimed.
    if (viewerId === null) continue;
    const record = readLockComment(issue.comments, viewerId);
    const classification = lockState(record?.data ?? null, {
      now,
      liveDispatchIds: [...liveDispatchIds],
    });
    if (!classification.orphaned) continue;

    const summary = `release the stale agent lock on ${issue.identifier}`;
    const terminal = isTerminal(issue.state);
    const approved = await ctx.confirm({ kind: "linear-write", summary });
    if (!approved) {
      skipped.push({
        stage: stageFor(record),
        issueId: issue.identifier,
        code: "reaper-declined",
        message: `Operator declined: ${summary}`,
      });
      continue;
    }
    try {
      const runningLabelIds = issue.labels
        .filter((label) => label.name === AGENT_LABEL.running)
        .map((label) => label.id);
      const addedLabelIds: string[] = [];
      if (!terminal) {
        const needsInputLabel = await ctx.linear.ensureLabel(BLOCKED_LABEL.needsInput, issue.team.id);
        addedLabelIds.push(needsInputLabel.id);
      }
      await ctx.linear.updateIssue(issue.id, {
        addedLabelIds,
        removedLabelIds: runningLabelIds,
      });
      await ctx.linear.createComment({
        issueId: issue.id,
        body:
          `Reaper: lock orphaned (${classification.reason}). ` +
          `Taken at ${record?.data.takenAt ?? "unknown"}, worktree ${record?.data.worktree ?? "unknown"} ` +
          `left standing for inspection — the reaper never deletes it.`,
      });
    } catch (error) {
      errors.push(`reaper failed on ${issue.identifier}: ${String(error)}`);
      continue;
    }

    const stage = stageFor(record);

    if (terminal) {
      // The issue is already completed/canceled — releasing the lock is the
      // whole job here. Raising blocked:needs-input on it would feed the
      // loop's backpressure signal forever, for work nobody will return to.
      skipped.push({
        stage,
        issueId: issue.identifier,
        code: "lock-orphaned-terminal",
        message: `Lock released without raising a decision — ${issue.identifier} is already ${issue.state.name}.`,
      });
      continue;
    }

    skipped.push({
      stage,
      issueId: issue.identifier,
      code: "lock-orphaned",
      message: classification.reason ?? "Lock past TTL and absent from every liveness source.",
    });
    blocked.push({
      issueId: issue.identifier,
      title: issue.title,
      type: "needsInput",
      question: classification.reason ?? "Lock past TTL and absent from every liveness source.",
      detectedAt: now.toISOString(),
      options: [],
      recommendation: null,
    });
  }

  return { worker: "reaper", ranAt: now.toISOString(), decisions: [], dispatched: [], skipped, errors, queues: { blocked } };
}

export const reaperWorker: Worker = {
  name: "reaper",
  cadenceMs: 5 * 60_000,
  run: runReaper,
};
