import { describe, expect, it } from "bun:test";
import {
  issueIdFromDispatchId,
  lockState,
  newDispatchId,
  readLockComment,
  renderLockComment,
  verifyLockOwnership,
  type LockRecord,
} from "../src/lock.ts";
import type { MarkerSource } from "../src/markers.ts";

function makeRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    dispatchId: "foreman-implement-ENG-1-20260101T000000Z-abc123",
    agent: "foreman-implement",
    issueId: "ENG-1",
    takenAt: "2026-01-01T00:00:00.000Z",
    ttlMs: 4 * 60 * 60 * 1000,
    worktree: "../foreman-ENG-1",
    released: false,
    releasedAt: null,
    ...overrides,
  };
}

describe("newDispatchId", () => {
  it("is unique across rapid calls", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const ids = new Set(
      Array.from({ length: 200 }, () => newDispatchId("foreman-implement", "ENG-1", now)),
    );
    expect(ids.size).toBe(200);
  });

  it("is greppable: carries the agent and issue id verbatim", () => {
    const id = newDispatchId("foreman-implement", "ENG-142", new Date("2026-01-01T00:00:00.000Z"));
    expect(id.startsWith("foreman-implement-ENG-142-")).toBe(true);
  });
});

describe("issueIdFromDispatchId", () => {
  it("recovers the issue id embedded by newDispatchId", () => {
    expect(issueIdFromDispatchId("foreman-implement-ENG-1-20260829T154350Z-ab12cd")).toBe("ENG-1");
  });

  it("returns null for a dispatch id that is not one of ours", () => {
    expect(issueIdFromDispatchId("not-a-dispatch-id")).toBeNull();
  });
});

describe("renderLockComment / readLockComment", () => {
  it("round-trips a LockRecord", () => {
    const record = makeRecord();
    const body = renderLockComment(record);
    const comments: MarkerSource[] = [{ id: "c1", body, createdAt: record.takenAt, user: { id: "bot-1" } }];
    const found = readLockComment(comments);
    expect(found).not.toBeNull();
    expect(found?.data).toEqual(record);
  });

  it("returns null when no lock comment is present", () => {
    expect(readLockComment([])).toBeNull();
  });

  it("finds the lock among comments from any author when authoredBy is omitted", () => {
    const record = makeRecord();
    const body = renderLockComment(record);
    const comments: MarkerSource[] = [{ id: "c1", body, createdAt: record.takenAt, user: { id: "bot-1" } }];
    const found = readLockComment(comments);
    expect(found).not.toBeNull();
    expect(found?.data).toEqual(record);
  });

  it("finds the lock when authoredBy matches the comment's user id", () => {
    const record = makeRecord();
    const body = renderLockComment(record);
    const comments: MarkerSource[] = [{ id: "c1", body, createdAt: record.takenAt, user: { id: "bot-1" } }];
    const found = readLockComment(comments, "bot-1");
    expect(found).not.toBeNull();
    expect(found?.data).toEqual(record);
  });

  it("ignores a lock-shaped comment from a different author when authoredBy is set", () => {
    const record = makeRecord();
    const body = renderLockComment(record);
    const comments: MarkerSource[] = [{ id: "c1", body, createdAt: record.takenAt, user: { id: "impostor" } }];
    const found = readLockComment(comments, "bot-1");
    expect(found).toBeNull();
  });
});

describe("lockState", () => {
  const now = new Date("2026-01-01T02:00:00.000Z");

  it("no record: not held, not orphaned", () => {
    const state = lockState(null, { now, liveDispatchIds: [] });
    expect(state).toMatchObject({ held: false, expired: false, orphaned: false });
  });

  it("released lock: not held", () => {
    const record = makeRecord({ released: true, releasedAt: "2026-01-01T01:00:00.000Z" });
    const state = lockState(record, { now, liveDispatchIds: [] });
    expect(state.held).toBe(false);
    expect(state.orphaned).toBe(false);
  });

  it("held and within TTL: not expired, not orphaned", () => {
    const record = makeRecord({ takenAt: "2026-01-01T01:00:00.000Z" });
    const state = lockState(record, { now, liveDispatchIds: [] });
    expect(state.held).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.orphaned).toBe(false);
  });

  it("expired but dispatch id still live: expired, NOT orphaned", () => {
    const record = makeRecord({ takenAt: "2025-01-01T00:00:00.000Z" });
    const state = lockState(record, { now, liveDispatchIds: [record.dispatchId] });
    expect(state.expired).toBe(true);
    expect(state.orphaned).toBe(false);
  });

  it("expired and absent from every liveness source: orphaned", () => {
    const record = makeRecord({ takenAt: "2025-01-01T00:00:00.000Z" });
    const state = lockState(record, { now, liveDispatchIds: ["some-other-dispatch"] });
    expect(state.expired).toBe(true);
    expect(state.orphaned).toBe(true);
  });

  it("treats a malformed timestamp as expired and orphanable rather than held forever", () => {
    const record = makeRecord({ takenAt: "not-a-timestamp" });
    const state = lockState(record, { now, liveDispatchIds: [] });
    expect(state).toMatchObject({ held: true, expired: true, orphaned: true });
  });
});

describe("verifyLockOwnership", () => {
  it("passes when the dispatch id matches the live lock", () => {
    const record = makeRecord();
    const result = verifyLockOwnership(record, record.dispatchId);
    expect(result.ok).toBe(true);
  });

  it("fails when there is no lock", () => {
    const result = verifyLockOwnership(null, "some-id");
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("no-lock");
  });

  it("fails when the lock is released", () => {
    const record = makeRecord({ released: true, releasedAt: "2026-01-01T01:00:00.000Z" });
    const result = verifyLockOwnership(record, record.dispatchId);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("lock-released");
  });

  it("rejects a mismatched dispatch id", () => {
    const record = makeRecord();
    const result = verifyLockOwnership(record, "a-different-dispatch-id");
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("dispatch-id-mismatch");
  });
});
