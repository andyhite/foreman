import { describe, expect, it } from "bun:test";
import { Canvas, charWidth, padTo, stringWidth, wrapText } from "../src/tui/index.ts";

describe("TUI width", () => {
  it("classifies emoji presentation and regional indicators as wide", () => {
    for (const codePoint of [0x1f680, 0x2600, 0x26a0, 0x2705, 0x2b50, 0x1fa70, 0x1f1e6]) {
      expect(charWidth(codePoint)).toBe(2);
    }
    // Modifiers extend the preceding emoji; counting them separately would
    // overstate a grapheme's terminal width.
    expect(charWidth(0x1f3fb)).toBe(0);
  });

  it("keeps padTo's output at the requested display width after truncating wide text", () => {
    const padded = padTo("界界", 3);
    expect(stringWidth(padded)).toBe(3);
  });

  it("hard-wraps a too-wide code point with progress", () => {
    expect(wrapText("🚀", 1)).toEqual(["🚀"]);
  });
});

describe("Canvas", () => {
  it("strips embedded ANSI control sequences before painting cells", () => {
    const canvas = new Canvas(12, 1);
    canvas.text(0, 0, "\x1b[31mred\x1b[0m \x1b]8;;https://example.test\x07link\x1b]8;;\x07");
    expect(canvas.toLines()[0]).toBe("red link");
  });
});
