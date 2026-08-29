/**
 * Centered overlay for help, confirm and input dialogs. 16-color terminals
 * cannot dim the backdrop, so "modal" here means "double-border box that
 * physically overwrites the region behind it" rather than a real overlay —
 * the caller is responsible for not drawing anything under it afterward.
 */

import type { Canvas, Rect } from "../canvas.ts";
import { center } from "../layout.ts";
import type { Theme } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

const DOUBLE_BOX = { h: "═", v: "║", tl: "╔", tr: "╗", bl: "╚", br: "╝" } as const;

export interface ModalOptions {
  theme: Theme;
  title: string;
  width: number;
  height: number;
  footer?: string;
}

export function modal(canvas: Canvas, outer: Rect, options: ModalOptions): Rect {
  const { theme, title, footer } = options;
  const width = Math.max(0, Math.min(options.width, outer.width));
  const height = Math.max(0, Math.min(options.height, outer.height));
  const rect = center(outer, width, height);
  const empty: Rect = { x: rect.x, y: rect.y, width: 0, height: 0 };
  if (rect.width <= 0 || rect.height <= 0) return empty;

  canvas.fill(rect, " ");
  if (rect.width < 2 || rect.height < 2) return empty;

  const sgr = theme.toneSgr("borderFocus");
  const innerWidth = rect.width - 2;
  const bottomY = rect.y + rect.height - 1;

  canvas.text(rect.x, rect.y, DOUBLE_BOX.tl, sgr);
  canvas.hline(rect.x + 1, rect.y, innerWidth, DOUBLE_BOX.h, sgr);
  canvas.text(rect.x + rect.width - 1, rect.y, DOUBLE_BOX.tr, sgr);
  canvas.text(rect.x, bottomY, DOUBLE_BOX.bl, sgr);
  canvas.hline(rect.x + 1, bottomY, innerWidth, DOUBLE_BOX.h, sgr);
  canvas.text(rect.x + rect.width - 1, bottomY, DOUBLE_BOX.br, sgr);
  canvas.vline(rect.x, rect.y + 1, Math.max(0, rect.height - 2), DOUBLE_BOX.v, sgr);
  canvas.vline(rect.x + rect.width - 1, rect.y + 1, Math.max(0, rect.height - 2), DOUBLE_BOX.v, sgr);

  const titleText = truncate(` ${title} `, innerWidth);
  canvas.text(rect.x + 1, rect.y, titleText, theme.sgr("bold"));

  if (footer !== undefined) {
    const footerText = truncate(` ${footer} `, innerWidth);
    const footerWidth = stringWidth(footerText);
    canvas.text(rect.x + rect.width - 1 - footerWidth, bottomY, footerText, theme.toneSgr("muted"));
  }

  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width: Math.max(0, rect.width - 2),
    height: Math.max(0, rect.height - 2),
  };
}
