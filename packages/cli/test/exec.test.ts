import { describe, expect, it } from "bun:test";
import { processRunner } from "../src/exec.ts";

describe("processRunner.capture", () => {
  it("resolves with the full stdout of a child that writes then exits immediately", async () => {
    // `close` (not `exit`) is what capture() waits on; a child that calls
    // process.exit() right after writing can fire `exit` before the stdout
    // pipe finishes draining, truncating or emptying what capture() sees.
    const written = "x".repeat(20_000);
    const result = await processRunner.capture("node", ["-e", `process.stdout.write(${JSON.stringify(written)}); process.exit(0);`]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(written);
  });
});
