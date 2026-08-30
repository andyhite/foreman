/**
 * The seven-tab `View` contract (contract section P).
 *
 * `app.ts` owns chrome, tab routing, and the modal stack; each view owns
 * only its body and its own key bindings. `ViewContext` is the seam between
 * them — a view never touches `Session` or `ControlClient` directly, only
 * `ctx.command`/`ctx.startLoop`, so every view stays testable against a
 * fake context and the six sibling views can be written against this file
 * without waiting on `app.ts`'s implementation.
 */

import type { Canvas, ControlOp, Key, LoopId, Rect, Theme } from "@foreman/core";
import type { Action, AppState, Toast } from "./store.ts";

export interface ViewContext {
  readonly state: AppState;
  readonly theme: Theme;
  readonly tick: number;
  dispatch(action: Action): void;
  /** Sends a control op to a loop, showing a toast on failure and clearing `busy` when it settles. Resolves `false` on failure so a caller can gate a follow-up action on success. */
  command(loopId: LoopId, op: ControlOp, params?: Record<string, unknown>): Promise<boolean>;
  /** Starts the loop's process if it is not running, then attaches. */
  startLoop(loopId: LoopId): void;
  toast(kind: Toast["kind"], message: string): void;
  suspend<T>(fn: () => Promise<T>): Promise<T>;
  requestRender(): void;
  openUrl(url: string): void;
}

export interface View {
  readonly id: string;
  readonly title: string;
  badge?(ctx: ViewContext): string | null;
  render(canvas: Canvas, rect: Rect, ctx: ViewContext): void;
  /** Return true when the key was consumed, so global bindings do not also fire. */
  handleKey(key: Key, ctx: ViewContext): boolean;
  hints(ctx: ViewContext): ReadonlyArray<readonly [string, string]>;
}

/** Tab order left to right — the single place that order is decided. */
export const VIEW_IDS = [
  "overview",
  "agents",
  "pipeline",
  "blocks",
  "proposals",
  "logs",
  "settings",
] as const;
