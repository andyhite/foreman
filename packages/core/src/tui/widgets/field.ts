/**
 * Editable settings-form row and its keystroke state machine. Rendering
 * (`fieldRow`) and key handling (`applyFieldKey`) are split on purpose:
 * the settings view owns the edit/commit lifecycle (dirty tracking,
 * validation, persistence) and only needs this module to turn one keypress
 * into "here is the next spec", never to touch the screen itself.
 */

import type { Canvas, Rect } from "../canvas.ts";
import type { Key } from "../keys.ts";
import type { Theme } from "../theme.ts";
import { padTo, stringWidth, truncate } from "../width.ts";

export type FieldSpec =
  | { kind: "text"; label: string; value: string; hint?: string }
  | { kind: "number"; label: string; value: number; min?: number; max?: number; step?: number; hint?: string }
  | { kind: "boolean"; label: string; value: boolean; hint?: string }
  | { kind: "select"; label: string; value: string; options: readonly string[]; hint?: string };

export interface FieldRowOptions {
  theme: Theme;
  spec: FieldSpec;
  focused: boolean;
  editing: boolean;
  labelWidth: number;
  error?: string;
  dirty?: boolean;
}

function displayValue(spec: FieldSpec, editing: boolean): string {
  switch (spec.kind) {
    case "text":
      return spec.value;
    case "number":
      return String(spec.value);
    case "boolean":
      return spec.value ? "[x]" : "[ ]";
    case "select":
      return editing ? `‹ ${spec.value} ›` : spec.value;
  }
}

export function fieldRow(canvas: Canvas, rect: Rect, options: FieldRowOptions): void {
  const { theme, spec, focused, editing, error, dirty } = options;
  if (rect.width <= 0 || rect.height <= 0) return;

  const labelWidth = Math.max(0, Math.min(options.labelWidth, rect.width));
  const labelSgr = focused ? theme.sgr("bold") : theme.toneSgr("muted");
  canvas.text(rect.x, rect.y, padTo(truncate(spec.label, labelWidth), labelWidth), labelSgr);

  const valueText = displayValue(spec, editing);
  const valueSgr = editing ? theme.toneSgr("chrome") : dirty ? theme.toneSgr("accent") : "";
  const valueX = rect.x + labelWidth + 1;

  const hintText = error ?? spec.hint ?? "";
  const spaceForRest = Math.max(0, rect.width - labelWidth - 1);
  const hintWidth = hintText ? Math.min(stringWidth(hintText), Math.max(0, spaceForRest - stringWidth(valueText) - 2)) : 0;
  const valueWidth = Math.max(0, spaceForRest - (hintWidth > 0 ? hintWidth + 2 : 0));

  canvas.text(valueX, rect.y, truncate(valueText, valueWidth), valueSgr);

  if (hintWidth > 0) {
    const clippedHint = truncate(hintText, hintWidth);
    const hintX = rect.x + rect.width - stringWidth(clippedHint);
    canvas.text(hintX, rect.y, clippedHint, error ? theme.toneSgr("danger") : theme.toneSgr("muted"));
  }
}

export interface FieldKeyResult {
  spec: FieldSpec;
  changed: boolean;
  committed: boolean;
  cancelled: boolean;
}

function noResult(spec: FieldSpec): FieldKeyResult {
  return { spec, changed: false, committed: false, cancelled: false };
}

function clampNumber(spec: Extract<FieldSpec, { kind: "number" }>, value: number): number {
  let next = value;
  if (spec.min !== undefined) next = Math.max(spec.min, next);
  if (spec.max !== undefined) next = Math.min(spec.max, next);
  return next;
}

function cycleSelect(spec: Extract<FieldSpec, { kind: "select" }>, delta: number): string {
  const options = spec.options;
  if (options.length === 0) return spec.value;
  const currentIndex = options.indexOf(spec.value);
  const nextIndex = ((currentIndex === -1 ? 0 : currentIndex) + delta + options.length) % options.length;
  return options[nextIndex] ?? spec.value;
}

export function applyFieldKey(spec: FieldSpec, key: Key, editing: boolean): FieldKeyResult {
  if (!editing) {
    if (spec.kind === "boolean" && (key.name === "enter" || key.name === "space")) {
      return { spec: { ...spec, value: !spec.value }, changed: true, committed: true, cancelled: false };
    }
    if (spec.kind === "select" && (key.name === "left" || key.name === "right")) {
      const value = cycleSelect(spec, key.name === "left" ? -1 : 1);
      return { spec: { ...spec, value }, changed: true, committed: true, cancelled: false };
    }
    if (spec.kind === "number") {
      const step = spec.step ?? 1;
      if (key.name === "left" || key.char === "-") {
        return { spec: { ...spec, value: clampNumber(spec, spec.value - step) }, changed: true, committed: true, cancelled: false };
      }
      if (key.name === "right" || key.char === "+") {
        return { spec: { ...spec, value: clampNumber(spec, spec.value + step) }, changed: true, committed: true, cancelled: false };
      }
    }
    return noResult(spec);
  }

  if (key.name === "escape") {
    return { spec, changed: false, committed: false, cancelled: true };
  }

  if (key.name === "enter") {
    if (spec.kind === "number") {
      return { spec: { ...spec, value: clampNumber(spec, spec.value) }, changed: false, committed: true, cancelled: false };
    }
    return { spec, changed: false, committed: true, cancelled: false };
  }

  switch (spec.kind) {
    case "text": {
      if (key.name === "backspace") {
        return { spec: { ...spec, value: spec.value.slice(0, -1) }, changed: true, committed: false, cancelled: false };
      }
      if (key.char && !key.ctrl && !key.alt) {
        return { spec: { ...spec, value: spec.value + key.char }, changed: true, committed: false, cancelled: false };
      }
      return noResult(spec);
    }
    case "number": {
      const step = spec.step ?? 1;
      if (key.name === "up") {
        return { spec: { ...spec, value: clampNumber(spec, spec.value + step) }, changed: true, committed: false, cancelled: false };
      }
      if (key.name === "down") {
        return { spec: { ...spec, value: clampNumber(spec, spec.value - step) }, changed: true, committed: false, cancelled: false };
      }
      if (key.name === "backspace") {
        const digits = String(spec.value).slice(0, -1);
        const parsed = digits === "" || digits === "-" ? 0 : Number(digits);
        return { spec: { ...spec, value: Number.isFinite(parsed) ? parsed : spec.value }, changed: true, committed: false, cancelled: false };
      }
      if (key.char && /^[0-9.-]$/.test(key.char)) {
        const digits = `${spec.value}${key.char}`;
        const parsed = Number(digits);
        if (Number.isFinite(parsed)) {
          return { spec: { ...spec, value: parsed }, changed: true, committed: false, cancelled: false };
        }
      }
      return noResult(spec);
    }
    case "boolean": {
      if (key.name === "space") {
        return { spec: { ...spec, value: !spec.value }, changed: true, committed: false, cancelled: false };
      }
      return noResult(spec);
    }
    case "select": {
      if (key.name === "left" || key.name === "right") {
        const value = cycleSelect(spec, key.name === "left" ? -1 : 1);
        return { spec: { ...spec, value }, changed: true, committed: false, cancelled: false };
      }
      return noResult(spec);
    }
  }
}
