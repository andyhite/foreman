import { describe, expect, it } from "bun:test";
import { nextProjectStatus } from "../src/project-status.ts";

describe("nextProjectStatus — backlog/planned to started (SPEC §7.6a)", () => {
  it("advances backlog to started once any issue is active", () => {
    expect(nextProjectStatus("backlog", ["unstarted", "started"])).toBe("started");
  });

  it("advances planned to started once any issue is done", () => {
    expect(nextProjectStatus("planned", ["unstarted", "completed"])).toBe("started");
  });

  it("stays put while every issue is still unstarted", () => {
    expect(nextProjectStatus("planned", ["unstarted", "unstarted"])).toBeNull();
  });
});

describe("nextProjectStatus — completion", () => {
  it("advances started to completed once every issue is terminal and at least one shipped", () => {
    expect(nextProjectStatus("started", ["completed", "canceled"])).toBe("completed");
  });

  it("advances straight from backlog to completed, skipping started, when issues already landed", () => {
    expect(nextProjectStatus("backlog", ["completed"])).toBe("completed");
  });

  it("does not complete an all-canceled project — abandonment is an operator call", () => {
    expect(nextProjectStatus("started", ["canceled", "canceled"])).toBeNull();
  });

  it("does not re-fire once already completed", () => {
    expect(nextProjectStatus("completed", ["completed"])).toBeNull();
  });
});

describe("nextProjectStatus — operator-owned statuses never auto-advance", () => {
  it("leaves paused alone even with active issues", () => {
    expect(nextProjectStatus("paused", ["started"])).toBeNull();
  });

  it("leaves canceled alone even with completed issues", () => {
    expect(nextProjectStatus("canceled", ["completed"])).toBeNull();
  });
});

describe("nextProjectStatus — no issues", () => {
  it("never fires for a bare project — that is the plan worker's job, not this one", () => {
    expect(nextProjectStatus("backlog", [])).toBeNull();
    expect(nextProjectStatus("planned", [])).toBeNull();
  });
});
