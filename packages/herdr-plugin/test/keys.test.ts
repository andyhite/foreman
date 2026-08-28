import { describe, expect, it } from "bun:test";
import { KeyDecoder } from "../src/tui/keys.ts";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("KeyDecoder arrows", () => {
  it("decodes the four arrow keys", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x1b, 0x5b, 0x41))).toEqual([{ kind: "up" }]);
    expect(decoder.push(bytes(0x1b, 0x5b, 0x42))).toEqual([{ kind: "down" }]);
    expect(decoder.push(bytes(0x1b, 0x5b, 0x43))).toEqual([{ kind: "right" }]);
    expect(decoder.push(bytes(0x1b, 0x5b, 0x44))).toEqual([{ kind: "left" }]);
  });
});

describe("KeyDecoder vim navigation", () => {
  it("maps j/k to down/up", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x6a))).toEqual([{ kind: "down" }]);
    expect(decoder.push(bytes(0x6b))).toEqual([{ kind: "up" }]);
  });
});

describe("KeyDecoder control keys", () => {
  it("decodes Enter, Tab, digits, and letters", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x0d))).toEqual([{ kind: "enter" }]);
    expect(decoder.push(bytes(0x09))).toEqual([{ kind: "tab" }]);
    expect(decoder.push(bytes(0x33))).toEqual([{ kind: "digit", value: 3 }]);
    expect(decoder.push(bytes(0x61))).toEqual([{ kind: "char", value: "a" }]);
  });
});

describe("KeyDecoder escape handling", () => {
  it("distinguishes a bare Escape from the start of a CSI sequence", () => {
    const decoder = new KeyDecoder();
    // A lone ESC with nothing following is held pending, not immediately
    // decoded — it could be the start of an arrow-key sequence.
    expect(decoder.push(bytes(0x1b))).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    // No continuation arrives: the caller's timer resolves it to a bare Escape.
    expect(decoder.flushPendingEscape()).toEqual({ kind: "escape" });
    expect(decoder.hasPending()).toBe(false);
  });

  it("decodes ESC not followed by [ or O as an immediate bare Escape", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x1b, 0x61))).toEqual([
      { kind: "escape" },
      { kind: "char", value: "a" },
    ]);
  });

  it("decodes an escape sequence split across two push() calls as one key", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x1b, 0x5b))).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.push(bytes(0x41))).toEqual([{ kind: "up" }]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("splits after only the ESC byte itself across two calls", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(bytes(0x1b))).toEqual([]);
    expect(decoder.push(bytes(0x5b, 0x42))).toEqual([{ kind: "down" }]);
  });
});
