import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bookkeeping } from "../src/bookkeeping.ts";

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "foreman-bookkeeping-"));
  return { dir, path: join(dir, "bookkeeping.json") };
}

describe("Bookkeeping.load", () => {
  it("a missing file loads as empty state rather than throwing", () => {
    const { dir, path } = tempPath();
    rmSync(dir, { recursive: true, force: true }); // path's parent doesn't even exist
    const bookkeeping = Bookkeeping.load(path);
    expect(bookkeeping.state.inFlight).toEqual([]);
    expect(bookkeeping.state.attempts).toEqual({});
    expect(bookkeeping.state.lastTriageRunAt).toBeNull();
    expect(bookkeeping.state.pendingDecisions).toEqual([]);
    expect(bookkeeping.totalInFlight()).toBe(0);
  });
});

describe("Bookkeeping.save — atomic write", () => {
  it("survives a concurrent read: readers see either the old or the new complete file, never a partial one", async () => {
    const { path } = tempPath();
    const a = Bookkeeping.load(path);
    a.recordDispatch({ agent: "foreman-implement", issueId: "ENG-1", dispatchId: "d1", startedAt: "2026-01-01T00:00:00.000Z", stage: "implement" });
    a.save();
    expect(existsSync(path)).toBe(true);

    const b = Bookkeeping.load(path);
    b.recordDispatch({ agent: "foreman-review", issueId: "ENG-2", dispatchId: "d2", startedAt: "2026-01-01T00:00:01.000Z", stage: "review" });

    // Interleave a save with a concurrent read of the file: because the write
    // path is temp-file-then-rename, the reader must always observe a fully
    // valid JSON document, never a half-written one.
    const results = await Promise.all([
      (async () => {
        b.save();
        return "saved";
      })(),
      (async () => {
        // Read whatever is on disk right now — either the pre-save or
        // post-save content is acceptable; garbage is not.
        const reloaded = Bookkeeping.load(path);
        return reloaded.state;
      })(),
    ]);
    expect(results[0]).toBe("saved");
    const finalState = Bookkeeping.load(path).state;
    expect(finalState.inFlight.some((entry) => entry.dispatchId === "d2")).toBe(true);
    // No temp file left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("round-trips through save/load", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    bookkeeping.setLastTriageRun(new Date("2026-02-01T06:00:00.000Z"));
    bookkeeping.setReviewedSha("ENG-5", "deadbeef");
    bookkeeping.save();

    const reloaded = Bookkeeping.load(path);
    expect(reloaded.state.lastTriageRunAt).toBe("2026-02-01T06:00:00.000Z");
    expect(reloaded.reviewedSha("ENG-5")).toBe("deadbeef");
  });
});

describe("Bookkeeping — in-flight tracking", () => {
  it("recordDispatch / clearDispatch / countInFlight / totalInFlight", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-1", dispatchId: "d1", startedAt: "now", stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-review", issueId: "ENG-2", dispatchId: "d2", startedAt: "now", stage: "review" });
    expect(bookkeeping.totalInFlight()).toBe(2);
    expect(bookkeeping.countInFlight("implement")).toBe(1);
    expect(bookkeeping.countInFlight("review")).toBe(1);
    expect(bookkeeping.countInFlight("refine")).toBe(0);

    bookkeeping.clearDispatch("d1");
    expect(bookkeeping.totalInFlight()).toBe(1);
    expect(bookkeeping.countInFlight("implement")).toBe(0);
  });

  it("reconcile drops records for issues no longer holding agent:running", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date("2026-03-01T00:00:00.000Z");
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-1", dispatchId: "d1", startedAt: now.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-implement", issueId: "ENG-2", dispatchId: "d2", startedAt: now.toISOString(), stage: "implement" });
    bookkeeping.recordDispatch({ agent: "foreman-review", issueId: null, dispatchId: "d3", startedAt: now.toISOString(), stage: "review" });

    // Only ENG-1 still carries agent:running in Linear; ENG-2's lock was
    // released (or expired and swept) while this process wasn't running.
    // The batch dispatch d3 remains only because the dispatcher confirms it live.
    bookkeeping.reconcile(new Set(["ENG-1"]), new Set(["d3"]), now, 60_000, 0);

    expect(bookkeeping.totalInFlight()).toBe(2);
    expect(bookkeeping.countInFlight("implement")).toBe(1);
    expect(bookkeeping.countInFlight("review")).toBe(1);
  });

  it("reconcile keeps a just-dispatched record inside claimGraceMs even though its issue isn't in the live set yet, and drops it once the grace window has elapsed", () => {
    const { path: freshPath } = tempPath();
    const fresh = Bookkeeping.load(freshPath);
    const now = new Date("2026-03-01T00:00:10.000Z");
    // Started 10s before `now` — well inside the task guard's claim window,
    // before `agent:running` has necessarily landed on the issue yet.
    fresh.recordDispatch({
      agent: "foreman-implement",
      issueId: "ENG-7",
      dispatchId: "d-fresh",
      startedAt: "2026-03-01T00:00:00.000Z",
      stage: "implement",
    });
    fresh.reconcile(new Set(), new Set(), now, 60_000, 300_000);
    expect(fresh.totalInFlight()).toBe(1);

    const { path: stalePath } = tempPath();
    const stale = Bookkeeping.load(stalePath);
    const later = new Date("2026-03-01T00:10:00.000Z");
    // Started 10 minutes before `later` — outside the 5-minute grace window,
    // and its issue still isn't in the live set, so it must be dropped as a
    // record whose dispatch never actually claimed the lock.
    stale.recordDispatch({
      agent: "foreman-implement",
      issueId: "ENG-7",
      dispatchId: "d-stale",
      startedAt: "2026-03-01T00:00:00.000Z",
      stage: "implement",
    });
    stale.reconcile(new Set(), new Set(), later, 60_000, 300_000);
    expect(stale.totalInFlight()).toBe(0);
  });
});

describe("Bookkeeping — retryCap exhaustion (SPEC §17.8)", () => {
  it("produces a decision request once the count exceeds retryCap, and not before", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date("2026-03-01T00:00:00.000Z");
    const retryCap = 2;

    const first = bookkeeping.recordAttemptFailure("implement", "ENG-9", retryCap, now);
    expect(first).toBeNull();
    const second = bookkeeping.recordAttemptFailure("implement", "ENG-9", retryCap, now);
    expect(second).toBeNull();
    const third = bookkeeping.recordAttemptFailure("implement", "ENG-9", retryCap, now);
    expect(third).not.toBeNull();
    expect(third).toMatchObject({ issueId: "ENG-9", stage: "implement", kind: "retry-exhausted", attempts: 3 });

    expect(bookkeeping.attemptCount("implement", "ENG-9")).toBe(3);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(1);

    const drained = bookkeeping.drainPendingDecisions();
    expect(drained).toHaveLength(1);
    expect(bookkeeping.state.pendingDecisions).toHaveLength(0);
  });

  it("resetAttempts clears the counter on a successful dispatch", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date();
    bookkeeping.recordAttemptFailure("refine", "ENG-4", 2, now);
    expect(bookkeeping.attemptCount("refine", "ENG-4")).toBe(1);
    bookkeeping.resetAttempts("refine", "ENG-4");
    expect(bookkeeping.attemptCount("refine", "ENG-4")).toBe(0);
  });

  it("counters for different issues or stages never collide", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date();
    bookkeeping.recordAttemptFailure("implement", "ENG-1", 2, now);
    bookkeeping.recordAttemptFailure("review", "ENG-1", 2, now);
    bookkeeping.recordAttemptFailure("implement", "ENG-2", 2, now);
    expect(bookkeeping.attemptCount("implement", "ENG-1")).toBe(1);
    expect(bookkeeping.attemptCount("review", "ENG-1")).toBe(1);
    expect(bookkeeping.attemptCount("implement", "ENG-2")).toBe(1);
  });
});

describe("Bookkeeping — review-cycle cap (SPEC §7.4)", () => {
  it("counts per issue, and only reports a decision past the cap", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date("2026-04-01T00:00:00.000Z");
    const reviewCycleCap = 2;

    expect(bookkeeping.recordReviewCycle("ENG-7", reviewCycleCap, now)).toBeNull();
    expect(bookkeeping.reviewCycleCount("ENG-7")).toBe(1);
    expect(bookkeeping.recordReviewCycle("ENG-7", reviewCycleCap, now)).toBeNull();
    expect(bookkeeping.reviewCycleCount("ENG-7")).toBe(2);
    const exceeded = bookkeeping.recordReviewCycle("ENG-7", reviewCycleCap, now);
    expect(exceeded).toMatchObject({ issueId: "ENG-7", stage: "review", kind: "review-cycle-exhausted", attempts: 3 });

    // A different issue's cycle count is independent.
    expect(bookkeeping.reviewCycleCount("ENG-8")).toBe(0);
  });

  it("resetReviewCycles clears the counter once the issue reaches Done", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    bookkeeping.recordReviewCycle("ENG-3", 2, new Date());
    expect(bookkeeping.reviewCycleCount("ENG-3")).toBe(1);
    bookkeeping.resetReviewCycles("ENG-3");
    expect(bookkeeping.reviewCycleCount("ENG-3")).toBe(0);
  });
});

describe("Bookkeeping — lastRunAt per worker", () => {
  it("setLastRun records an ISO timestamp per stage independently", () => {
    const { path } = tempPath();
    const bookkeeping = Bookkeeping.load(path);
    const now = new Date("2026-05-01T00:00:00.000Z");
    bookkeeping.setLastRun("implement", now);
    expect(bookkeeping.state.lastRunAt.implement).toBe(now.toISOString());
    expect(bookkeeping.state.lastRunAt.refine).toBeNull();
  });
});
