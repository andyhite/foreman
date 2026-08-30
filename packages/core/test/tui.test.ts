import { describe, expect, it } from "bun:test";
import { Canvas, charWidth, padTo, stringWidth, wrapText } from "../src/tui/index.ts";
import { splitHorizontal } from "../src/tui/layout.ts";

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

  it("blanks the wide lead when overwriting its continuation cell", () => {
    const canvas = new Canvas(6, 1);
    canvas.text(0, 0, "界界界");
    canvas.text(1, 0, "x");
    expect(stringWidth(canvas.toLines()[0] ?? "")).toBe(6);
  });

  it("blanks the continuation cell when overwriting a wide lead", () => {
    const canvas = new Canvas(6, 1);
    canvas.text(0, 0, "界abcd");
    canvas.text(0, 0, "x");
    expect(stringWidth(canvas.toLines()[0] ?? "")).toBe(6);
  });

  it("appends a zero-width combining mark to the preceding cell instead of dropping it", () => {
    const canvas = new Canvas(4, 1);
    canvas.text(0, 0, "e\u0301"); // "e" + combining acute accent (NFD)
    expect(canvas.toLines()[0]).toBe("e\u0301");
  });
});

describe("layout distribute", () => {
  it("never sums past the available width even when fixed mins exceed it", () => {
    const rects = splitHorizontal({ x: 0, y: 0, width: 20, height: 1 }, [
      { fixed: 10 },
      { fixed: 10 },
      { fixed: 10 },
    ]);
    const total = rects.reduce((sum, rect) => sum + rect.width, 0);
    expect(total).toBeLessThanOrEqual(20);
  });

  it("distributes flex space exactly, with no overflow, at realistic terminal widths", () => {
    for (const total of [127, 130, 140]) {
      const specs = Array.from({ length: 11 }, () => ({ flex: 1, min: 6 }));
      const rects = splitHorizontal({ x: 0, y: 0, width: total, height: 1 }, specs, 1);
      const sum = rects.reduce((total_, rect) => total_ + rect.width, 0) + (specs.length - 1);
      expect(sum).toBeLessThanOrEqual(total);
    }
  });
});
