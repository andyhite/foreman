import { describe, expect, it } from "bun:test";
import { countdown, duration, relativeTime, truncateMiddle } from "../src/format.ts";

describe("relativeTime", () => {
  const now = Date.parse("2026-01-01T00:10:00.000Z");

  it("returns em-dash for null", () => {
    expect(relativeTime(null, now)).toBe("—");
  });

  it("formats sub-minute deltas in seconds", () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe("30s");
  });

  it("formats sub-hour deltas in minutes", () => {
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
  });

  it("formats sub-day deltas in hours", () => {
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h");
  });

  it("formats multi-day deltas in days", () => {
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d");
  });
});

describe("duration", () => {
  it("formats seconds only", () => {
    expect(duration(45_000)).toBe("45s");
  });

  it("formats hours and minutes", () => {
    expect(duration(72 * 60_000)).toBe("1h 12m");
  });
});

describe("countdown", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it('reports "due" once the deadline has passed', () => {
    expect(countdown(new Date(now - 1000).toISOString(), now)).toBe("due");
  });

  it("reports a future deadline in seconds", () => {
    expect(countdown(new Date(now + 10_000).toISOString(), now)).toBe("in 10s");
  });
});

describe("truncateMiddle", () => {
  it("returns text unchanged at exactly the target width", () => {
    const text = "0123456789";
    expect(truncateMiddle(text, 10)).toBe(text);
  });

  it("truncates with an ellipsis one under the exact width", () => {
    const text = "0123456789";
    const result = truncateMiddle(text, 9);
    expect(result).toHaveLength(9);
    expect(result).toContain("…");
    expect(result.startsWith("0123")).toBe(true);
  });
});
