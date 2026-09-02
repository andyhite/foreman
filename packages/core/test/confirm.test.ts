import { describe, expect, it } from "bun:test";
import { verboseConfirmer, YOLO_CONFIRMER, DENY_CONFIRMER, type ConfirmRequest } from "../src/confirm.ts";

describe("verboseConfirmer", () => {
  it("logs the summary and detail before delegating to the inner confirmer", async () => {
    const lines: string[] = [];
    const confirmer = verboseConfirmer(YOLO_CONFIRMER, (message) => lines.push(message));
    const request: ConfirmRequest = {
      kind: "dispatch",
      summary: "dispatch foreman-implement for ENG-142",
      detail: ["command: /foreman-implement ENG-142", "cwd: /repo"],
    };
    const approved = await confirmer.confirm(request);
    expect(approved).toBe(true);
    expect(lines[0]).toContain("dispatch foreman-implement for ENG-142");
    expect(lines[1]).toContain("command: /foreman-implement ENG-142");
    expect(lines[2]).toContain("cwd: /repo");
  });

  it("returns the inner confirmer's decision, not always true", async () => {
    const confirmer = verboseConfirmer(DENY_CONFIRMER, () => {});
    const approved = await confirmer.confirm({ kind: "linear-write", summary: "apply proposal" });
    expect(approved).toBe(false);
  });

  it("closes the inner confirmer", () => {
    let closed = false;
    const confirmer = verboseConfirmer({ confirm: () => Promise.resolve(true), close: () => (closed = true) }, () => {});
    confirmer.close();
    expect(closed).toBe(true);
  });
});
