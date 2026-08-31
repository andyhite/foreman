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
  lockTtlMs,
  readLockComment,
  type BlockedItem,
} from "@foreman/core";
import type { Worker, WorkerContext, WorkerReport } from "./types.ts";

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

  const running = await ctx.linear.issues({ filter: IN_FLIGHT_FILTER, limit: 500, includeComments: true });
  if (running.length >= 500) {
    ctx.log(`reaper: query returned a full page of 500 in-flight issues; some may not have been swept this pass.`);
  }

  // Live dispatch ids: anything the loop itself started and has not yet
  // cleared from bookkeeping. This is deliberately non-authoritative (SPEC
  // §17.5) — a lock absent from here but present in the omp registry (which
  // this process cannot see across a restart) is still only reported, not
  // force-cleared, unless it is also past TTL.
  const liveDispatchIds = new Set(ctx.bookkeeping.state.inFlight.map((entry) => entry.dispatchId));
  const liveIssueIds = new Set(running.map((issue) => issue.identifier));

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
      stage: record?.data.agent === "foreman-refine"
        ? "refine"
        : record?.data.agent === "foreman-review"
          ? "review"
          : record?.data.agent === "foreman-plan"
            ? "plan"
            : "implement",
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
    liveIssueIds.delete(issue.identifier);
  }
  ctx.bookkeeping.reconcile(liveIssueIds, liveDispatchIds, now, lockTtlMs(ctx.config));

  return { worker: "reaper", ranAt: now.toISOString(), decisions: [], dispatched: [], skipped, errors, queues: { blocked } };
}

export const reaperWorker: Worker = {
  name: "reaper",
  cadenceMs: 5 * 60_000,
  run: runReaper,
};
