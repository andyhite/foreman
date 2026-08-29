/**
 * The one-row tab bar switching between overview/agents/pipeline/blocks/
 * proposals/logs/settings. Digit prefixes double as the numeric key
 * bindings, so the digit and label are always styled and truncated
 * together rather than as independent strings.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

export interface TabsOptions {
  theme: Theme;
  labels: readonly string[];
  active: number;
  badges?: readonly (string | null)[];
}

export function tabsBar(canvas: Canvas, rect: Rect, options: TabsOptions): void {
  const { theme, labels, active, badges } = options;
  if (rect.width <= 0 || rect.height <= 0) return;

  const rightEdge = rect.x + rect.width;
  let x = rect.x;

  for (let i = 0; i < labels.length; i++) {
    if (x >= rightEdge) break;
    const label = labels[i] ?? "";
    const badgeText = badges?.[i];
    const isActive = i === active;
    const digitPart = ` ${i + 1} `;
    const tail = badgeText ? `${label} ${badgeText}` : label;
    const suffix = isActive ? `${tail} ` : tail;

    const remaining = rightEdge - x;
    const digitClipped = truncate(digitPart, remaining);
    const digitWidth = stringWidth(digitClipped);
    const suffixClipped = truncate(suffix, Math.max(0, remaining - digitWidth));

    if (isActive) {
      canvas.text(x, rect.y, digitClipped, theme.sgr("reverse"));
      canvas.text(x + digitWidth, rect.y, suffixClipped, theme.sgr("reverse"));
    } else {
      canvas.text(x, rect.y, digitClipped, theme.toneSgr("key"));
      canvas.text(x + digitWidth, rect.y, suffixClipped, theme.toneSgr("muted"));
    }

    x += digitWidth + stringWidth(suffixClipped);
  }
}
