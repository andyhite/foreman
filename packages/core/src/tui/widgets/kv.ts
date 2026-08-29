/**
 * Label/value detail rows for modal detail views and the settings summary.
 * A value can be multi-line (e.g. a wrapped question or recommendation), so
 * this expands entries into physical rows before scrolling — the caller's
 * `scroll` addresses rendered rows, not logical entries.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { padTo, stringWidth, truncate } from "../width.ts";

export interface KvOptions {
  theme: Theme;
  entries: readonly (readonly [string, string])[];
  labelWidth?: number;
  scroll?: number;
}

export function kvRows(canvas: Canvas, rect: Rect, options: KvOptions): void {
  const { theme, entries } = options;
  if (rect.width <= 0 || rect.height <= 0) return;

  const maxLabelWidth = Math.max(1, Math.floor(rect.width / 3));
  const widestLabel = entries.reduce((max, [label]) => Math.max(max, stringWidth(label)), 0);
  const labelWidth = Math.max(0, Math.min(options.labelWidth ?? widestLabel, maxLabelWidth));
  const valueWidth = Math.max(0, rect.width - labelWidth - 1);

  const rows: Array<readonly [string, string]> = [];
  for (const [label, value] of entries) {
    const lines = value.split("\n");
    rows.push([label, lines[0] ?? ""]);
    for (let i = 1; i < lines.length; i++) rows.push(["", lines[i] ?? ""]);
  }

  const scroll = Math.max(0, options.scroll ?? 0);
  for (let i = 0; i < rect.height; i++) {
    const row = rows[scroll + i];
    if (!row) break;
    const [label, value] = row;
    const y = rect.y + i;
    canvas.text(rect.x, y, padTo(truncate(label, labelWidth), labelWidth), theme.toneSgr("muted"));
    canvas.text(rect.x + labelWidth + 1, y, truncate(value, valueWidth));
  }
}
