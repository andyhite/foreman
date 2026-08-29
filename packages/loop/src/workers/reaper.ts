/**
 * Lock reaper (SPEC §11): sweeps expired `agent:running` locks. Never deletes
 * a worktree — it reports what it found and flags it; the operator decides.
 */

import {
  AGENT_LABEL,
  BLOCKED_LABEL,
  IN_FLIGHT_FILTER,
  hasLabel,
  lockState,
  readLockComment,
  type BlockedItem,
} from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

async function runReaper(ctx: WorkerContext): Promise<WorkerReport> {
  const now = ctx.now();
  const errors: string[] = [];
  const skipped: WorkerReport["skipped"] = [];
  const blocked: BlockedItem[] = [];

  const running = await ctx.linear.issues({ filter: IN_FLIGHT_FILTER, limit: 500, includeComments: true });

  // Live dispatch ids: anything the loop itself started and has not yet
  // cleared from bookkeeping. This is deliberately non-authoritative (SPEC
  // §17.5) — a lock absent from here but present in the omp registry (which
  // this process cannot see across a restart) is still only reported, not
  // force-cleared, unless it is also past TTL.
  const liveDispatchIds = new Set(ctx.bookkeeping.state.inFlight.map((entry) => entry.dispatchId));

  for (const issue of running) {
    if (!hasLabel(issue, AGENT_LABEL.running)) continue;
    const record = readLockComment(issue.comments);
    const classification = lockState(record?.data ?? null, {
      now,
      liveDispatchIds: [...liveDispatchIds],
    });
    if (!classification.orphaned) continue;

    if (!ctx.dryRun) {
      try {
        const runningLabelIds = issue.labels
          .filter((label) => label.name === AGENT_LABEL.running)
          .map((label) => label.id);
        const needsInputLabel = await ctx.linear.ensureLabel(BLOCKED_LABEL.needsInput, issue.team.id);
        await ctx.linear.updateIssue(issue.id, {
          addedLabelIds: [needsInputLabel.id],
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
    }

    skipped.push({
      stage: "implement",
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

  ctx.bookkeeping.reconcile(new Set(running.map((issue) => issue.identifier)), liveDispatchIds);

  return { worker: "reaper", ranAt: now.toISOString(), dispatched: [], skipped, errors, queues: { blocked } };
}

export const reaperWorker: Worker = {
  name: "reaper",
  cadenceMs: 5 * 60_000,
  run: runReaper,
};
