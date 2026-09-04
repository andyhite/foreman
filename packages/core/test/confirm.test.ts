import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { verboseConfirmer, YOLO_CONFIRMER, DENY_CONFIRMER, TtyConfirmer, type ConfirmRequest } from "../src/confirm.ts";

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

describe("TtyConfirmer", () => {
  it("resolves true for a bare 'y' answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const confirmer = new TtyConfirmer({ input, output, log: (message) => logs.push(message) });
    const pending = confirmer.confirm({ kind: "dispatch", summary: "dispatch foreman-implement for ENG-1" });
    input.write("y\n");
    expect(await pending).toBe(true);
    confirmer.close();
  });

  it("resolves false for any non-affirmative answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const confirmer = new TtyConfirmer({ input, output, log: () => {} });
    const pending = confirmer.confirm({ kind: "linear-write", summary: "apply proposal" });
    input.write("maybe\n");
    expect(await pending).toBe(false);
    confirmer.close();
  });

  it("resolves false when the input stream ends without an answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const confirmer = new TtyConfirmer({ input, output, log: () => {} });
    const pending = confirmer.confirm({ kind: "linear-write", summary: "apply proposal" });
    input.end();
    expect(await pending).toBe(false);
  });

  it("resolves false with no prompt written once closed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const confirmer = new TtyConfirmer({ input, output, log: () => {} });
    confirmer.close();
    const approved = await confirmer.confirm({ kind: "linear-write", summary: "apply proposal" });
    expect(approved).toBe(false);
    expect(Buffer.concat(written).toString()).not.toContain("Proceed?");
  });
});
