/**
 * Scrolling column table — the workhorse widget for agents, pipeline,
 * blocked and proposal views, all of which are "list of records, one
 * selected" with the same scroll-into-view and full-row-highlight needs.
 *
 * Selection paints as a reverse bar across the *entire* row width,
 * including the inter-column gaps, so it reads as one continuous highlight
 * rather than per-cell fragments — that is why the row is pre-painted with
 * a full-width blank before column text is stamped on top.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { SizeSpec } from "../layout.ts";
import { splitHorizontal } from "../layout.ts";
import type { Theme } from "../theme.ts";
import { padTo, stringWidth, truncate } from "../width.ts";

export interface Column<T> {
  header: string;
  width: SizeSpec;
  align?: "left" | "right" | "center";
  render(row: T, index: number): string;
  sgr?(row: T, index: number): string | undefined;
}

export interface TableOptions<T> {
  theme: Theme;
  columns: readonly Column<T>[];
  rows: readonly T[];
  selected?: number;
  scroll?: number;
  focused?: boolean;
  emptyMessage?: string;
  showHeader?: boolean;
}

export interface TableResult {
  scroll: number;
  visibleRows: number;
}

export function table<T>(canvas: Canvas, rect: Rect, options: TableOptions<T>): TableResult {
  const { theme, columns, rows, selected } = options;
  const showHeader = options.showHeader ?? true;
  if (rect.width <= 0 || rect.height <= 0) return { scroll: 0, visibleRows: 0 };

  const cols = splitHorizontal(rect, columns.map((column) => column.width), 1);
  const headerHeight = showHeader ? Math.min(1, rect.height) : 0;
  const bodyY = rect.y + headerHeight;
  const visible = Math.max(0, rect.height - headerHeight);

  if (headerHeight > 0) {
    const headerSgr = theme.sgr("dim", "bold");
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      const colRect = cols[c];
      if (!column || !colRect || colRect.width <= 0) continue;
      const cell = padTo(truncate(column.header, colRect.width), colRect.width, column.align ?? "left");
      canvas.text(colRect.x, rect.y, cell, headerSgr);
    }
  }

  if (rows.length === 0) {
    const message = options.emptyMessage ?? "nothing here";
    if (visible > 0) {
      const y = bodyY + Math.floor((visible - 1) / 2);
      const clipped = truncate(message, rect.width);
      const x = rect.x + Math.max(0, Math.floor((rect.width - stringWidth(clipped)) / 2));
      canvas.text(x, y, clipped, theme.toneSgr("muted"));
    }
    return { scroll: 0, visibleRows: visible };
  }

  const maxScroll = Math.max(0, rows.length - visible);
  let scroll = Math.min(Math.max(options.scroll ?? 0, 0), maxScroll);
  if (selected !== undefined && visible > 0) {
    if (selected < scroll) scroll = selected;
    else if (selected > scroll + visible - 1) scroll = selected - visible + 1;
    scroll = Math.min(Math.max(scroll, 0), maxScroll);
  }

  for (let i = 0; i < visible; i++) {
    const rowIndex = scroll + i;
    const row = rows[rowIndex];
    if (row === undefined) break;
    const rowY = bodyY + i;
    const isSelected = rowIndex === selected;
    const reverseSgr = theme.sgr("reverse");
    if (isSelected) {
      canvas.text(rect.x, rowY, " ".repeat(rect.width), reverseSgr);
    }
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      const colRect = cols[c];
      if (!column || !colRect || colRect.width <= 0) continue;
      const raw = column.render(row, rowIndex);
      const cell = padTo(truncate(raw, colRect.width), colRect.width, column.align ?? "left");
      const cellSgr = isSelected ? reverseSgr : (column.sgr?.(row, rowIndex) ?? "");
      canvas.text(colRect.x, rowY, cell, cellSgr);
    }
  }

  return { scroll, visibleRows: visible };
}
