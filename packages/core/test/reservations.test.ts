import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReservations,
  reservationsPath,
  reserveDispatches,
  takeReservation,
  type DispatchReservation,
} from "../src/dispatch/reservations.ts";

const TTL_MS = 4 * 60 * 60 * 1000;
const NOW = new Date("2026-01-01T12:00:00.000Z");

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-reservations-"));
  dirs.push(dir);
  return dir;
}

function makeEntry(overrides: Partial<DispatchReservation> = {}): DispatchReservation {
  return {
    agent: "foreman-refine",
    subject: "ENG-1",
    dispatchId: "foreman-refine-ENG-1-20260101T120000Z-abc123",
    reservedAt: NOW.toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("takeReservation", () => {
  it("resolves the id the loop reserved for that agent and subject", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(path, [makeEntry()], NOW, TTL_MS);

    expect(takeReservation(path, "foreman-refine", "ENG-1", NOW, TTL_MS)).toBe(
      "foreman-refine-ENG-1-20260101T120000Z-abc123",
    );
  });

  it("consumes the reservation, so a later call for the same subject mints instead", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(path, [makeEntry()], NOW, TTL_MS);

    takeReservation(path, "foreman-refine", "ENG-1", NOW, TTL_MS);

    expect(takeReservation(path, "foreman-refine", "ENG-1", NOW, TTL_MS)).toBeNull();
  });

  it("keeps every other item's reservation when one is consumed", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(
      path,
      [
        makeEntry({ subject: "ENG-1", dispatchId: "d-1" }),
        makeEntry({ subject: "ENG-2", dispatchId: "d-2" }),
        makeEntry({ subject: "ENG-3", dispatchId: "d-3" }),
      ],
      NOW,
      TTL_MS,
    );

    expect(takeReservation(path, "foreman-refine", "ENG-2", NOW, TTL_MS)).toBe("d-2");
    expect(readReservations(path).map((entry) => entry.dispatchId)).toEqual(["d-1", "d-3"]);
  });

  it("ignores a reservation past its TTL rather than attaching a lock nothing is watching", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(path, [makeEntry({ reservedAt: "2026-01-01T00:00:00.000Z" })], NOW, TTL_MS * 4);

    expect(takeReservation(path, "foreman-refine", "ENG-1", NOW, TTL_MS)).toBeNull();
    expect(readReservations(path)).toEqual([]);
  });

  it("does not cross agents holding the same subject", () => {
    const dir = makeDir();
    const path = reservationsPath(dir, "foreman-review");
    reserveDispatches(path, [makeEntry({ agent: "foreman-review", dispatchId: "review-1" })], NOW, TTL_MS);

    expect(takeReservation(path, "foreman-refine", "ENG-1", NOW, TTL_MS)).toBeNull();
    expect(takeReservation(path, "foreman-review", "ENG-1", NOW, TTL_MS)).toBe("review-1");
  });

  it("is null for an operator dispatch that reserved nothing", () => {
    const path = reservationsPath(makeDir(), "foreman-plan");

    expect(takeReservation(path, "foreman-plan", "project-1", NOW, TTL_MS)).toBeNull();
  });
});

describe("reserveDispatches", () => {
  it("replaces a prior reservation for the same subject, since the newer dispatch is the tracked one", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(path, [makeEntry({ dispatchId: "stale" })], NOW, TTL_MS);
    reserveDispatches(path, [makeEntry({ dispatchId: "current" })], NOW, TTL_MS);

    expect(readReservations(path).map((entry) => entry.dispatchId)).toEqual(["current"]);
  });

  it("prunes entries past TTL while recording a new batch", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    reserveDispatches(
      path,
      [makeEntry({ subject: "ENG-9", dispatchId: "old", reservedAt: "2026-01-01T00:00:00.000Z" })],
      new Date("2026-01-01T00:00:00.000Z"),
      TTL_MS,
    );

    reserveDispatches(path, [makeEntry({ subject: "ENG-1", dispatchId: "new" })], NOW, TTL_MS);

    expect(readReservations(path).map((entry) => entry.dispatchId)).toEqual(["new"]);
  });

  it("leaves no temp file behind", () => {
    const dir = makeDir();
    reserveDispatches(reservationsPath(dir, "foreman-refine"), [makeEntry()], NOW, TTL_MS);

    expect(readdirSync(dir)).toEqual(["foreman-refine.json"]);
  });
});

describe("readReservations", () => {
  it("is empty for a loop that has dispatched nothing", () => {
    expect(readReservations(reservationsPath(makeDir(), "foreman-plan"))).toEqual([]);
  });

  it("is empty rather than fatal for a truncated or hand-edited file", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    writeFileSync(path, '[{"agent":"foreman-refine","subject":"ENG-1"');

    expect(readReservations(path)).toEqual([]);
  });

  it("drops entries missing a field instead of handing the guard a partial reservation", () => {
    const path = reservationsPath(makeDir(), "foreman-refine");
    writeFileSync(path, JSON.stringify([{ agent: "foreman-refine", subject: "ENG-1" }, makeEntry()]));

    expect(readReservations(path).map((entry) => entry.subject)).toEqual(["ENG-1"]);
    expect(readReservations(path)).toHaveLength(1);
  });
});
