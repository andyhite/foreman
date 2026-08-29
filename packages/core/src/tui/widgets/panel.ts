/**
 * Bordered panel chrome shared by every TUI view (SPEC §17 control-plane UI).
 *
 * Every view draws inside a titled box, so the border-drawing, title/subtitle
 * placement, and focus-tinting logic lives here once rather than being
 * re-derived per view. The tension: title, subtitle and footer all compete
 * for the same one-row border, so this module truncates subtitle first
 * (title is the load-bearing label) before ever cutting the title itself.
 */

import type { Canvas, Rect } from "../canvas.ts";
import { BOX } from "../canvas.ts";
import { inset } from "../layout.ts";
import type { Theme, ToneName } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

export interface PanelOptions {
  theme: Theme;
  title?: string;
  subtitle?: string;
  focused?: boolean;
  footer?: string;
  tone?: ToneName;
}

export function panel(canvas: Canvas, rect: Rect, options: PanelOptions): Rect {
  const { theme, title, subtitle, focused, footer } = options;
  const empty: Rect = { x: rect.x, y: rect.y, width: 0, height: 0 };
  if (rect.width <= 0 || rect.height <= 0) return empty;

  const borderTone: ToneName = options.tone ?? (focused ? "borderFocus" : "border");
  const borderSgr = theme.toneSgr(borderTone);

  if (rect.width < 3 || rect.height < 3) {
    // Too small for a real frame; paint whatever border pixels fit and give
    // up on content — a caller that lays out this tightly gets no crash.
    canvas.text(rect.x, rect.y, BOX.tl, borderSgr);
    if (rect.width > 1) canvas.hline(rect.x + 1, rect.y, rect.width - 1, BOX.h, borderSgr);
    return empty;
  }

  const innerWidth = rect.width - 2;

  // Top border: draw the full rule first, then stamp title/subtitle on top.
  canvas.text(rect.x, rect.y, BOX.tl, borderSgr);
  canvas.hline(rect.x + 1, rect.y, innerWidth, BOX.h, borderSgr);
  canvas.text(rect.x + rect.width - 1, rect.y, BOX.tr, borderSgr);

  let titleText = title !== undefined ? ` ${title} ` : "";
  let subtitleText = subtitle !== undefined ? ` ${subtitle} ` : "";
  let titleWidth = stringWidth(titleText);
  let subtitleWidth = stringWidth(subtitleText);
  if (titleWidth + subtitleWidth > innerWidth) {
    subtitleText = truncate(subtitleText, Math.max(0, innerWidth - titleWidth));
    subtitleWidth = stringWidth(subtitleText);
  }
  if (titleWidth + subtitleWidth > innerWidth) {
    titleText = truncate(titleText, Math.max(0, innerWidth - subtitleWidth));
    titleWidth = stringWidth(titleText);
  }
  if (titleText) {
    const titleSgr = focused ? theme.sgr("bold") : theme.toneSgr("muted");
    canvas.text(rect.x + 1, rect.y, titleText, titleSgr);
  }
  if (subtitleText) {
    canvas.text(rect.x + rect.width - 1 - subtitleWidth, rect.y, subtitleText, theme.toneSgr("muted"));
  }

  // Side borders.
  canvas.vline(rect.x, rect.y + 1, rect.height - 2, BOX.v, borderSgr);
  canvas.vline(rect.x + rect.width - 1, rect.y + 1, rect.height - 2, BOX.v, borderSgr);

  // Bottom border, footer right-aligned.
  const bottomY = rect.y + rect.height - 1;
  canvas.text(rect.x, bottomY, BOX.bl, borderSgr);
  canvas.hline(rect.x + 1, bottomY, innerWidth, BOX.h, borderSgr);
  canvas.text(rect.x + rect.width - 1, bottomY, BOX.br, borderSgr);
  if (footer !== undefined) {
    const footerText = truncate(` ${footer} `, innerWidth);
    const footerWidth = stringWidth(footerText);
    canvas.text(rect.x + rect.width - 1 - footerWidth, bottomY, footerText, theme.toneSgr("muted"));
  }

  return inset(rect, 1);
}
