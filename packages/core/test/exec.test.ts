import { describe, expect, it } from "bun:test";
import { CommandFailed, nodeRunner } from "../src/git/exec.ts";

describe("nodeRunner timeout", () => {
  it("rejects a command that exceeds an injected timeout, rather than hanging", async () => {
    await expect(
      nodeRunner.run(["sleep", "5"], { cwd: process.cwd(), timeoutMs: 50 }),
    ).rejects.toThrow(CommandFailed);
  });
});
