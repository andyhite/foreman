/**
 * Rect arithmetic for stacking panels. The tension this resolves: a layout
 * needs fixed-size chrome (a 1-row header, a 1-row footer) *and* flexible
 * body panels that share whatever is left, and the split must be exact —
 * off-by-one rounding here is what makes a border overlap the row below it.
 * Largest-remainder rounding guarantees the flex shares sum to exactly the
 * space left after fixed sizes and gaps are subtracted.
 */

import type { Rect } from "./canvas.ts";

export type SizeSpec = { fixed: number } | { flex: number; min?: number; max?: number };

function isFixed(spec: SizeSpec): spec is { fixed: number } {
  return "fixed" in spec;
}

function distribute(total: number, specs: readonly SizeSpec[]): number[] {
  const sizes = new Array<number>(specs.length).fill(0);
  let remaining = total;

  specs.forEach((spec, i) => {
    if (isFixed(spec)) {
      const size = Math.max(0, Math.min(spec.fixed, remaining));
      sizes[i] = size;
      remaining -= size;
    }
  });

  const flexIndices: number[] = [];
  let totalWeight = 0;
  specs.forEach((spec, i) => {
    if (spec !== undefined && !isFixed(spec)) {
      flexIndices.push(i);
      totalWeight += Math.max(0, spec.flex);
    }
  });

  if (flexIndices.length > 0 && remaining > 0 && totalWeight > 0) {
    const raw = flexIndices.map((i) => {
      const spec = specs[i];
      const weight = spec !== undefined && !isFixed(spec) ? Math.max(0, spec.flex) : 0;
      return (weight / totalWeight) * remaining;
    });
    const floors = raw.map(Math.floor);
    let allocated = floors.reduce((a, b) => a + b, 0);
    let leftover = remaining - allocated;
    const remainders = raw
      .map((value, idx) => ({ idx, frac: value - Math.floor(value) }))
      .sort((a, b) => b.frac - a.frac);
    for (const { idx } of remainders) {
      if (leftover <= 0) break;
      floors[idx] = (floors[idx] ?? 0) + 1;
      leftover--;
    }
    flexIndices.forEach((specIdx, i) => {
      sizes[specIdx] = floors[i] ?? 0;
    });

    // Second pass: clamp to min/max, then redistribute the delta across the
    // remaining unclamped flex slots by weight so the total stays exact.
    let delta = 0;
    const unclamped: number[] = [];
    let unclampedWeight = 0;
    flexIndices.forEach((specIdx) => {
      const spec = specs[specIdx];
      if (spec === undefined || isFixed(spec)) return;
      const min = spec.min ?? 0;
      const max = spec.max ?? Number.POSITIVE_INFINITY;
      const size = sizes[specIdx] ?? 0;
      const clamped = Math.max(min, Math.min(max, size));
      if (clamped !== size) {
        delta += size - clamped;
        sizes[specIdx] = clamped;
      } else {
        unclamped.push(specIdx);
        unclampedWeight += Math.max(0, spec.flex);
      }
    });
    if (delta !== 0 && unclamped.length > 0 && unclampedWeight > 0) {
      let remainingDelta = delta;
      unclamped.forEach((specIdx, i) => {
        const spec = specs[specIdx];
        if (spec === undefined || isFixed(spec)) return;
        const weight = Math.max(0, spec.flex);
        const share = i === unclamped.length - 1 ? remainingDelta : Math.round((weight / unclampedWeight) * delta);
        sizes[specIdx] = Math.max(0, (sizes[specIdx] ?? 0) + share);
        remainingDelta -= share;
      });
    }
  }

  return sizes;
}

/** Stacks `specs` top-to-bottom inside `rect`, separated by `gap` rows. */
export function splitVertical(rect: Rect, specs: readonly SizeSpec[], gap = 0): Rect[] {
  const totalGap = gap * Math.max(0, specs.length - 1);
  const sizes = distribute(Math.max(0, rect.height - totalGap), specs);
  const rects: Rect[] = [];
  let y = rect.y;
  sizes.forEach((size, i) => {
    rects.push({ x: rect.x, y, width: rect.width, height: Math.max(0, size) });
    y += size + (i < sizes.length - 1 ? gap : 0);
  });
  return rects;
}

/** Splits `specs` left-to-right inside `rect`, separated by `gap` columns. */
export function splitHorizontal(rect: Rect, specs: readonly SizeSpec[], gap = 0): Rect[] {
  const totalGap = gap * Math.max(0, specs.length - 1);
  const sizes = distribute(Math.max(0, rect.width - totalGap), specs);
  const rects: Rect[] = [];
  let x = rect.x;
  sizes.forEach((size, i) => {
    rects.push({ x, y: rect.y, width: Math.max(0, size), height: rect.height });
    x += size + (i < sizes.length - 1 ? gap : 0);
  });
  return rects;
}

/** Shrinks `rect` by the given margins, clockwise from `top`; CSS-shorthand rules for omitted args. */
export function inset(rect: Rect, top: number, right?: number, bottom?: number, left?: number): Rect {
  const r = right ?? top;
  const b = bottom ?? top;
  const l = left ?? r;
  const width = Math.max(0, rect.width - l - r);
  const height = Math.max(0, rect.height - top - b);
  return { x: rect.x + l, y: rect.y + top, width, height };
}

/** Centers a `width` x `height` box inside `outer`. */
export function center(outer: Rect, width: number, height: number): Rect {
  const w = Math.min(width, outer.width);
  const h = Math.min(height, outer.height);
  return {
    x: outer.x + Math.max(0, Math.floor((outer.width - w) / 2)),
    y: outer.y + Math.max(0, Math.floor((outer.height - h) / 2)),
    width: w,
    height: h,
  };
}

export function isEmpty(rect: Rect): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

/** Clips `rect` so it lies entirely within `bounds`. */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const x0 = Math.max(rect.x, bounds.x);
  const y0 = Math.max(rect.y, bounds.y);
  const x1 = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const y1 = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
