/**
 * The one-row tab bar switching between overview/agents/pipeline/blocks/
 * proposals/logs/settings. Digit prefixes double as the numeric key
 * bindings, so the digit and label are always styled and truncated
 * together rather than as independent strings.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Theme, ToneName } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

export interface TabSegment {
  label: string;
  badge?: string | null;
  tone?: ToneName;
}

export interface TabsOptions {
  theme: Theme;
  labels: readonly string[];
  active: number;
  badges?: readonly (string | null)[];
  leading?: {
    segments: readonly TabSegment[];
    active: number;
  };
}

function segmentText(segment: TabSegment, index: number, count: number): string {
  const prefix = index === 0 ? "┃ " : " ┃ ";
  const suffix = index === count - 1 ? " ┃" : "";
  return `${prefix}${segment.label}${segment.badge ? ` ${segment.badge}` : ""}${suffix}`;
}

function renderLeadingSegments(
  canvas: Canvas,
  rect: Rect,
  theme: Theme,
  options: NonNullable<TabsOptions["leading"]>,
): number {
  const { segments, active } = options;
  const rightEdge = rect.x + rect.width;
  let x = rect.x;

  for (let index = 0; index < segments.length; index += 1) {
    if (x >= rightEdge) break;
    const segment = segments[index];
    if (!segment) continue;
    const text = segmentText(segment, index, segments.length);
    const clipped = truncate(text, rightEdge - x);
    const isActive = index === active;
    const sgr = isActive ? theme.sgr("reverse") : theme.toneSgr("muted");
    canvas.text(x, rect.y, clipped, sgr);

    /*
     * A stale sibling must announce itself even while another loop owns the
     * body. Paint its connection badge over the dim chip only when the whole
     * badge survived truncation; otherwise the compact chip itself is still
     * the higher-priority scope cue and no partial status word can mislead.
     */
    if (!isActive && segment.badge && segment.tone && stringWidth(clipped) === stringWidth(text)) {
      const badgeX = x + stringWidth(`${index === 0 ? "┃ " : " ┃ "}${segment.label} `);
      canvas.text(badgeX, rect.y, segment.badge, theme.toneSgr(segment.tone));
    }
    x += stringWidth(clipped);
  }
  return x;
}

export function tabsBar(canvas: Canvas, rect: Rect, options: TabsOptions): void {
  const { theme, labels, active, badges, leading } = options;
  if (rect.width <= 0 || rect.height <= 0) return;

  const rightEdge = rect.x + rect.width;
  /*
   * Scope comes first because every body is scoped: a clipped view name is
   * recoverable through its number key, but a missing scope would make every
   * visible datum ambiguous. The tabs therefore spend only what remains after
   * the complete leading group (and its boundary) has had its budget.
   */
  let x = leading ? renderLeadingSegments(canvas, rect, theme, leading) : rect.x;
  if (leading && x < rightEdge) {
    x += canvas.text(x, rect.y, "│", theme.toneSgr("key"));
  }

  /*
   * A badge is a bare number rendered after its label, and the next tab
   * opens with its own bare digit — so `overview 2  2 agents` reads as one
   * tab with two numbers rather than the boundary between two tabs. The
   * separator is what makes the digit unambiguously a key binding again.
   * It is drawn before each tab but the first, so it never trails the row.
   */
  for (let i = 0; i < labels.length; i++) {
    if (x >= rightEdge) break;
    if (i > 0) {
      x += canvas.text(x, rect.y, "│", theme.toneSgr("muted"));
      if (x >= rightEdge) break;
    }
    const label = labels[i] ?? "";
    const badgeText = badges?.[i];
    const isActive = i === active;
    const digitPart = ` ${i + 1} `;
    const tail = badgeText ? `${label} ${badgeText}` : label;
    const suffix = `${tail} `;

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
