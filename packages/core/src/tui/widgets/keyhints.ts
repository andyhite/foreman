/**
 * Footer key-hint bar. The footer is one row and the hint list is
 * open-ended per view, so hints must drop whole pairs from the end rather
 * than truncate mid-pair — a half-rendered "ctrl-" is worse than a shorter
 * list.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { stringWidth } from "../width.ts";

/**
 * Paints a footer key-hint bar directly into `canvas` at `rect.y`, plain
 * text plus per-segment `sgr` — never a pre-styled joined string, which
 * `Canvas.text` would count as one column per escape byte and truncate
 * hints instead of the whole list fitting.
 */
export function keyHints(canvas: Canvas, rect: Rect, theme: Theme, hints: readonly (readonly [string, string])[]): void {
  if (rect.width <= 0) return;

  const segments: Array<{ key: string; label: string }> = [];
  let used = 0;
  let truncated = false;
  for (const [key, label] of hints) {
    const plain = `${key} ${label}`;
    const separator = segments.length > 0 ? " · " : "";
    const additional = stringWidth(separator) + stringWidth(plain);
    if (used + additional > rect.width) {
      truncated = true;
      break;
    }
    segments.push({ key, label });
    used += additional;
  }

  let x = rect.x;
  segments.forEach((segment, index) => {
    if (index > 0) x += canvas.text(x, rect.y, " · ", theme.sgr());
    x += canvas.text(x, rect.y, segment.key, theme.toneSgr("key"));
    x += canvas.text(x, rect.y, " ", theme.sgr());
    x += canvas.text(x, rect.y, segment.label, theme.toneSgr("muted"));
  });
  if (truncated && used + stringWidth(" · …?") <= rect.width) {
    x += canvas.text(x, rect.y, " · ", theme.sgr());
    x += canvas.text(x, rect.y, "…?", theme.toneSgr("muted"));
  }
}
