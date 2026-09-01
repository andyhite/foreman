/**
 * View-layer layout helpers built on `@foreman/core` rect splits.
 */

import type { Rect } from "@foreman/core";
import { splitHorizontal, splitVertical, type SizeSpec } from "@foreman/core";
import { LIST_DETAIL_STACK_WIDTH } from "./pane.ts";

export function listDetailLayout(
  rect: Rect,
  horizontal: readonly [SizeSpec, SizeSpec],
  vertical: readonly [SizeSpec, SizeSpec],
): readonly [Rect, Rect] {
  if (rect.width < LIST_DETAIL_STACK_WIDTH) {
    return splitVertical(rect, vertical) as [Rect, Rect];
  }
  return splitHorizontal(rect, horizontal) as [Rect, Rect];
}

/** True when list-over-detail vertical stacking is active. */
export function isStackedListDetail(rect: Rect): boolean {
  return rect.width < LIST_DETAIL_STACK_WIDTH;
}
