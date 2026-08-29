/**
 * Tailing log pane shared by the logs view and any per-loop log excerpt.
 * Filtering happens before windowing so `total` (used to size the
 * scrollbar-equivalent hints elsewhere) reflects what is actually visible,
 * not the raw buffer size.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { stripAnsi } from "../theme.ts";
import { truncate, wrapText } from "../width.ts";

export interface LogViewOptions {
  theme: Theme;
  lines: readonly string[];
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

export function logView(canvas: Canvas, rect: Rect, options: LogViewOptions): LogViewResult {
  const { lines, follow, filter, wrap } = options;
  if (rect.width <= 0 || rect.height <= 0) {
    return { scroll: Math.max(0, options.scroll), total: 0, visible: 0 };
  }

  let filtered: readonly string[] = lines;
  if (filter) {
    const needle = filter.toLowerCase();
    filtered = lines.filter((line) => stripAnsi(line).toLowerCase().includes(needle));
  }

  let displayLines: string[];
  if (wrap) {
    displayLines = [];
    for (const line of filtered) displayLines.push(...wrapText(line, rect.width));
  } else {
    displayLines = filtered as string[];
  }

  const total = displayLines.length;
  const visible = rect.height;
  const maxScroll = Math.max(0, total - visible);
  const scroll = follow ? maxScroll : Math.min(Math.max(options.scroll, 0), maxScroll);

  for (let i = 0; i < visible; i++) {
    const line = displayLines[scroll + i];
    if (line === undefined) break;
    canvas.text(rect.x, rect.y + i, truncate(line, rect.width));
  }

  return { scroll, total, visible };
}
