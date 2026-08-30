/**
 * WIP gauges (`used/cap` per stage) and the tick-history sparkline on the
 * overview. Both are single-row, 16-color-safe renderings of a bounded
 * series — no dependency on truecolor gradients, just three fixed tone
 * thresholds and eight block glyphs.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

export interface GaugeOptions {
  theme: Theme;
  value: number;
  max: number;
  label?: string;
  warnAt?: number;
  dangerAt?: number;
}

export function gauge(canvas: Canvas, rect: Rect, options: GaugeOptions): void {
  const { theme, value, max, label } = options;
  if (rect.width <= 0 || rect.height <= 0) return;

  const warnAt = options.warnAt ?? max * 0.7;
  const dangerAt = options.dangerAt ?? max;
  const tone = value >= dangerAt ? "badgeDanger" : value >= warnAt ? "badgeWarn" : "badgeOk";

  const labelText = label !== undefined ? `${label} ` : "";
  const suffix = ` ${value}/${max}`;
  const labelWidth = Math.min(stringWidth(labelText), rect.width);
  const suffixWidth = Math.min(stringWidth(suffix), Math.max(0, rect.width - labelWidth));
  const barWidth = Math.max(0, rect.width - labelWidth - suffixWidth - 2);

  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * barWidth);
  const unfilled = Math.max(0, barWidth - filled);

  let x = rect.x;
  if (labelWidth > 0) {
    canvas.text(x, rect.y, truncate(labelText, labelWidth), theme.toneSgr("muted"));
    x += labelWidth;
  }
  if (labelWidth + suffixWidth + 2 <= rect.width) {
    canvas.text(x, rect.y, "[", theme.toneSgr("muted"));
    x += 1;
    canvas.text(x, rect.y, "█".repeat(filled), theme.toneSgr(tone));
    x += filled;
    canvas.text(x, rect.y, "░".repeat(unfilled), theme.toneSgr("muted"));
    x += unfilled;
    canvas.text(x, rect.y, "]", theme.toneSgr("muted"));
    x += 1;
  }
  canvas.text(x, rect.y, truncate(suffix, Math.max(0, rect.width - (x - rect.x))), theme.toneSgr("muted"));
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** Right-aligned over the most recent `width` values; always exactly `width` columns. */
export function sparkline(values: readonly number[], width: number): string {
  if (width <= 0) return "";
  if (values.length === 0) return "·".repeat(width);

  const windowValues = values.slice(-width);
  const max = Math.max(0, ...windowValues);
  const chars = windowValues.map((value) => {
    if (max <= 0) return BLOCKS[0] as string;
    const idx = Math.min(BLOCKS.length - 1, Math.floor((value / max) * (BLOCKS.length - 1)));
    return (BLOCKS[idx] as string) ?? (BLOCKS[0] as string);
  });

  const padding = "·".repeat(Math.max(0, width - chars.length));
  return `${padding}${chars.join("")}`.slice(-width);
}
