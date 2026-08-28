/**
 * A selectable list with a detail region, viewport scrolling, and hard
 * width wrapping — the shared rendering primitive behind every board screen
 * (SPEC §17.4). Pure functions over plain data: no terminal I/O here, so it
 * is directly unit-testable (`test/list.test.ts`).
 */

export interface ListItem {
  /** Rendered on the list line itself. */
  label: string;
  /** Rendered in the detail region when this item is selected. */
  detail: string[];
}

export interface ListViewState {
  /** Index of the selected item into `items`. */
  selected: number;
  /** Index of the first visible item — the scroll offset. */
  scrollTop: number;
}

export function initialListView(): ListViewState {
  return { selected: 0, scrollTop: 0 };
}

/** Wraps at both ends: moving up from index 0 lands on the last item and vice versa. */
export function moveSelection(
  view: ListViewState,
  itemCount: number,
  delta: 1 | -1,
): ListViewState {
  if (itemCount === 0) return view;
  const next = (view.selected + delta + itemCount) % itemCount;
  return { ...view, selected: next };
}

/**
 * Clamps `scrollTop` so `selected` stays within a `visibleRows`-tall window —
 * scrolls down when the selection runs past the bottom, up when it runs past
 * the top. Called after every `moveSelection` and every resize.
 */
export function scrollToSelection(view: ListViewState, visibleRows: number): ListViewState {
  if (visibleRows <= 0) return view;
  if (view.selected < view.scrollTop) {
    return { ...view, scrollTop: view.selected };
  }
  if (view.selected >= view.scrollTop + visibleRows) {
    return { ...view, scrollTop: view.selected - visibleRows + 1 };
  }
  return view;
}

/** Breaks `text` into lines no wider than `width`, breaking on spaces where possible. */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    if (word.length <= width) {
      current = word;
    } else {
      // A single word longer than the width: hard-break it.
      let rest = word;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      current = rest;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export interface RenderListOptions {
  title: string;
  items: ListItem[];
  view: ListViewState;
  width: number;
  /** Rows available for the list column; the rest of the frame holds the detail region. */
  listRows: number;
  emptyMessage: string;
}

/**
 * Renders the list column plus the selected item's wrapped detail region as
 * one frame body. Every line is truncated or wrapped to `width` — a line
 * wider than the terminal corrupts the alternate-screen layout, so this is
 * the single enforcement point every screen routes through.
 */
export function renderList(options: RenderListOptions): string[] {
  const { title, items, view, width, listRows, emptyMessage } = options;
  const lines: string[] = [padTruncate(title, width), padTruncate("-".repeat(title.length), width)];

  if (items.length === 0) {
    lines.push(padTruncate(emptyMessage, width));
    return lines;
  }

  const visible = items.slice(view.scrollTop, view.scrollTop + listRows);
  visible.forEach((item, offset) => {
    const index = view.scrollTop + offset;
    const marker = index === view.selected ? "> " : "  ";
    lines.push(padTruncate(`${marker}${item.label}`, width));
  });

  lines.push(padTruncate("", width));
  const selectedItem = items[view.selected];
  if (selectedItem) {
    for (const detailLine of selectedItem.detail) {
      for (const wrapped of wrapLine(detailLine, width)) {
        lines.push(padTruncate(wrapped, width));
      }
    }
  }

  return lines;
}

function padTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? text.slice(0, width) : text;
}
