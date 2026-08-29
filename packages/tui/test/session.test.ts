import { describe, expect, it } from "bun:test";
import type { GlobalConfig, LoopId } from "@foreman/core";
import { Session } from "../src/session.ts";

describe("Session.ensureRunning", () => {
  it("refuses manual starts for an attach-only session", async () => {
    const actions: Array<Record<string, unknown>> = [];
    const session = new Session({
      config: {} as GlobalConfig,
      loopIds: [],
      team: null,
      noStart: true,
      onAction: (action) => actions.push(action),
    });

    await session.ensureRunning("repo:example" as LoopId);

    expect(actions).toEqual([
      {
        type: "toast",
        kind: "warn",
        message: "repo:example: --no-start is set, not spawning a loop process",
      },
    ]);
  });
});
