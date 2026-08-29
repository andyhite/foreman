/**
 * Tailing log pane shared by the logs view and any per-loop log excerpt.
 * Filtering happens before windowing so `total` (used to size the
 * scrollbar-equivalent hints elsewhere) reflects what is actually visible,
 * not the raw buffer size.
 *
 * Lines are segments of plain text plus a per-segment `sgr`, never a
 * pre-styled string — `Canvas.text` has no ANSI awareness, so a caller
 * that embedded escape codes in the text would burn one canvas column per
 * escape byte and cut the message short.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { stringWidth, wrapText } from "../width.ts";

export interface LogViewSegment {
  text: string;
  sgr?: string;
}

export type LogViewLine = readonly LogViewSegment[];

export interface LogViewOptions {
  theme: Theme;
  lines: readonly LogViewLine[];
  scroll: number;
  follow: boolean;
  filter?: string;
  wrap?: boolean;
}

export interface LogViewResult {
  scroll: number;
  total: number;
  visible: number;
}

function plainOf(line: LogViewLine): string {
  return line.map((segment) => segment.text).join("");
}

export function logView(canvas: Canvas, rect: Rect, options: LogViewOptions): LogViewResult {
  const { lines, follow, filter, wrap } = options;
  if (rect.width <= 0 || rect.height <= 0) {
    return { scroll: Math.max(0, options.scroll), total: 0, visible: 0 };
  }

  let filtered: readonly LogViewLine[] = lines;
  if (filter) {
    const needle = filter.toLowerCase();
    filtered = lines.filter((line) => plainOf(line).toLowerCase().includes(needle));
  }

  let displayLines: readonly LogViewLine[];
  if (wrap) {
    // Wrapping needs to re-break across segment boundaries; not exercised
    // by any current caller, so wrapped lines fall back to plain text
    // (no per-segment styling) rather than growing that machinery unused.
    const wrapped: LogViewLine[] = [];
    for (const line of filtered) {
      for (const wrapped_line of wrapText(plainOf(line), rect.width)) wrapped.push([{ text: wrapped_line }]);
    }
    displayLines = wrapped;
  } else {
    displayLines = filtered;
  }

  const total = displayLines.length;
  const visible = rect.height;
  const maxScroll = Math.max(0, total - visible);
  const scroll = follow ? maxScroll : Math.min(Math.max(options.scroll, 0), maxScroll);

  for (let i = 0; i < visible; i++) {
    const line = displayLines[scroll + i];
    if (line === undefined) break;
    const rowY = rect.y + i;
    const plainWidth = stringWidth(plainOf(line));
    const overflow = plainWidth > rect.width;
    const paintWidth = overflow ? Math.max(0, rect.width - 1) : rect.width;
    const clip: Rect = { x: rect.x, y: rowY, width: paintWidth, height: 1 };
    let x = rect.x;
    for (const segment of line) {
      if (x >= rect.x + paintWidth) break;
      x += canvas.text(x, rowY, segment.text, segment.sgr ?? "", clip);
    }
    if (overflow) canvas.text(x, rowY, "…", "", { x: rect.x, y: rowY, width: rect.width, height: 1 });
  }

  return { scroll, total, visible };
}
