/**
 * An off-screen character grid that every view paints into and `Screen`
 * diffs against the real terminal. Keeping rendering and diffing separate
 * from the widgets means widgets can be pure functions of `(canvas, rect,
 * options)` with no knowledge of the terminal, and `Screen` only has to
 * compare two frames of plain strings — no widget needs to know how to
 * avoid flicker or partial escape sequences, `Canvas`/`Screen` own that.
 *
 * Cells are stored as two parallel flat arrays (`chars`, `sgrs`) rather than
 * an array of cell objects: this is a hot path (redrawn up to `fps` times a
 * second) and avoids one allocation per cell per frame.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

import { charWidth } from "./width.ts";

const CONTINUATION = "";

function clampClip(clip: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, clip.x);
  const y0 = Math.max(0, clip.y);
  const x1 = Math.min(width, clip.x + clip.width);
  const y1 = Math.min(height, clip.y + clip.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export class Canvas {
  #width: number;
  #height: number;
  #chars: string[];
  #sgrs: string[];

  constructor(width: number, height: number) {
    this.#width = Math.max(0, width);
    this.#height = Math.max(0, height);
    this.#chars = new Array(this.#width * this.#height).fill(" ");
    this.#sgrs = new Array(this.#width * this.#height).fill("");
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  resize(width: number, height: number): void {
    this.#width = Math.max(0, width);
    this.#height = Math.max(0, height);
    this.#chars = new Array(this.#width * this.#height).fill(" ");
    this.#sgrs = new Array(this.#width * this.#height).fill("");
  }

  clear(sgr = ""): void {
    this.#chars.fill(" ");
    this.#sgrs.fill(sgr);
  }

  #index(x: number, y: number): number {
    return y * this.#width + x;
  }

  #setCell(x: number, y: number, char: string, sgr: string): void {
    if (x < 0 || x >= this.#width || y < 0 || y >= this.#height) return;
    const idx = this.#index(x, y);
    this.#chars[idx] = char;
    this.#sgrs[idx] = sgr;
  }

  text(x: number, y: number, text: string, sgr = "", clip?: Rect): number {
    const bounds = clampClip(clip ?? { x: 0, y: 0, width: this.#width, height: this.#height }, this.#width, this.#height);
    if (bounds.width <= 0 || bounds.height <= 0) return 0;
    if (y < bounds.y || y >= bounds.y + bounds.height) return 0;

    let col = x;
    const left = bounds.x;
    const right = bounds.x + bounds.width;
    let advanced = 0;

    for (const ch of text) {
      const codePoint = ch.codePointAt(0);
      if (codePoint === undefined) continue;
      const w = charWidth(codePoint);
      if (w === 0) continue;
      if (col >= right) break;
      if (col + w > right) break;
      if (col >= left) {
        this.#setCell(col, y, ch, sgr);
        if (w === 2) this.#setCell(col + 1, y, CONTINUATION, sgr);
      }
      col += w;
      advanced += w;
    }
    return advanced;
  }

  fill(rect: Rect, char = " ", sgr = ""): void {
    const bounds = clampClip(rect, this.#width, this.#height);
    for (let row = bounds.y; row < bounds.y + bounds.height; row++) {
      for (let col = bounds.x; col < bounds.x + bounds.width; col++) {
        this.#setCell(col, row, char, sgr);
      }
    }
  }

  hline(x: number, y: number, width: number, char: string, sgr = ""): void {
    for (let i = 0; i < width; i++) {
      this.#setCell(x + i, y, char, sgr);
    }
  }

  vline(x: number, y: number, height: number, char: string, sgr = ""): void {
    for (let i = 0; i < height; i++) {
      this.#setCell(x, y + i, char, sgr);
    }
  }

  toLines(): string[] {
    const lines: string[] = [];
    for (let row = 0; row < this.#height; row++) {
      let line = "";
      let runSgr: string | null = null;
      let runChars = "";
      const flush = () => {
        if (runSgr === null) return;
        if (runChars === "") {
          runSgr = null;
          return;
        }
        if (runSgr === "") {
          line += runChars;
        } else {
          line += runSgr + runChars + "\x1b[0m";
        }
        runSgr = null;
        runChars = "";
      };
      for (let col = 0; col < this.#width; col++) {
        const idx = this.#index(col, row);
        const ch = this.#chars[idx] ?? " ";
        if (ch === CONTINUATION) continue;
        const sgr = this.#sgrs[idx] ?? "";
        if (runSgr === null) {
          runSgr = sgr;
          runChars = ch;
        } else if (sgr === runSgr) {
          runChars += ch;
        } else {
          flush();
          runSgr = sgr;
          runChars = ch;
        }
      }
      flush();
      line = line.replace(/ +$/u, "");
      lines.push(line);
    }
    return lines;
  }
}

export const BOX = {
  h: "─",
  v: "│",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  lt: "├",
  rt: "┤",
  tt: "┬",
  bt: "┴",
  x: "┼",
} as const;
