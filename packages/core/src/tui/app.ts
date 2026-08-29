/**
 * The TUI's render/input event loop (SPEC §17 control-plane UI).
 *
 * A screen-owning host would either busy-poll (wasting a CPU core to
 * redraw an unchanged frame) or hand-roll ad hoc debouncing per call site.
 * `TuiRuntime` centralizes both: a coalesced render scheduler capped at
 * `fps` so bursts of key/resize/socket events collapse into one repaint,
 * and a slower wall-clock tick that exists purely to advance spinners and
 * relative timestamps when nothing else changed. `suspend()` exists
 * because `herdr agent focus` and `$EDITOR` need the real terminal, not
 * the alternate screen buffer, for the duration of one external process.
 */

import { Canvas } from "./canvas.ts";
import type { Rect } from "./canvas.ts";
import type { Key } from "./keys.ts";
import { Screen } from "./screen.ts";
import type { Theme } from "./theme.ts";
import { defaultTheme } from "./theme.ts";

export interface AppFrame {
  canvas: Canvas;
  rect: Rect;
  tick: number;
}

export interface TuiHost {
  render(frame: AppFrame): void;
  handleKey(key: Key): void;
  onResize?(columns: number, rows: number): void;
}

export interface TuiRuntimeOptions {
  screen?: Screen;
  theme?: Theme;
  fps?: number;
  tickMs?: number;
}

export class TuiRuntime {
  #host: TuiHost;
  #screen: Screen;
  #theme: Theme;
  #canvas: Canvas;
  #fps: number;
  #tickMs: number;
  #tick = 0;

  #renderPending = false;
  #renderTimer: ReturnType<typeof setTimeout> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;

  #settled = false;
  #resolveStart: ((code: number) => void) | null = null;
  #rejectStart: ((error: unknown) => void) | null = null;
  #unsubscribeKey: (() => void) | null = null;
  #unsubscribeResize: (() => void) | null = null;
  #pendingResize: { columns: number; rows: number } | null = null;

  constructor(host: TuiHost, options: TuiRuntimeOptions = {}) {
    this.#host = host;
    this.#screen = options.screen ?? new Screen();
    this.#theme = options.theme ?? defaultTheme;
    this.#fps = options.fps ?? 30;
    this.#tickMs = options.tickMs ?? 1000;
    this.#canvas = new Canvas(Math.max(1, this.#screen.columns), Math.max(1, this.#screen.rows));
  }

  get theme(): Theme {
    return this.#theme;
  }

  get tick(): number {
    return this.#tick;
  }

  start(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    this.#settled = false;
    this.#resolveStart = resolve;
    this.#rejectStart = reject;

    try {
      this.#screen.enter();
      this.#canvas.resize(this.#screen.columns, this.#screen.rows);

      this.#unsubscribeKey = this.#screen.onKey((key) => {
        try {
          this.#host.handleKey(key);
        } catch (error) {
          this.#fail(error);
        }
      });

      this.#unsubscribeResize = this.#screen.onResize((columns, rows) => {
        this.#pendingResize = { columns, rows };
        this.#screen.invalidate();
        this.requestRender();
      });

      this.#startTickTimer();
      this.#renderNow();
    } catch (error) {
      this.#fail(error);
    }

    return promise;
  }

  /** Coalesced repaint request; safe to call from anywhere, any number of times per frame. */
  requestRender(): void {
    if (this.#renderPending || this.#settled) return;
    this.#renderPending = true;
    this.#renderTimer = setTimeout(() => {
      this.#renderPending = false;
      this.#renderTimer = null;
      this.#renderNow();
    }, 1000 / this.#fps);
  }

  quit(code = 0): void {
    if (this.#settled) return;
    const resolve = this.#resolveStart;
    this.#teardown();
    this.#settled = true;
    resolve?.(code);
  }

  /** Leaves the alternate screen for `fn`, then restores it — guaranteed even if `fn` rejects. */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.#stopTickTimer();
    this.#screen.leave();
    try {
      return await fn();
    } finally {
      this.#screen.enter();
      this.#canvas.resize(this.#screen.columns, this.#screen.rows);
      this.#screen.invalidate();
      this.#startTickTimer();
      this.#renderNow();
    }
  }

  #renderNow(): void {
    if (this.#settled) return;
    const resize = this.#pendingResize;
    this.#pendingResize = null;
    if (resize) {
      this.#canvas.resize(resize.columns, resize.rows);
      this.#host.onResize?.(resize.columns, resize.rows);
    }
    const rect: Rect = { x: 0, y: 0, width: this.#canvas.width, height: this.#canvas.height };
    this.#canvas.clear();
    try {
      this.#host.render({ canvas: this.#canvas, rect, tick: this.#tick });
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#screen.render(this.#canvas);
  }

  #startTickTimer(): void {
    this.#stopTickTimer();
    this.#tickTimer = setInterval(() => {
      this.#tick += 1;
      this.requestRender();
    }, this.#tickMs);
  }

  #stopTickTimer(): void {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  #fail(error: unknown): void {
    if (this.#settled) return;
    const reject = this.#rejectStart;
    this.#teardown();
    this.#settled = true;
    if (reject) reject(error);
  }

  #teardown(): void {
    this.#stopTickTimer();
    if (this.#renderTimer) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
    }
    this.#renderPending = false;
    this.#unsubscribeKey?.();
    this.#unsubscribeKey = null;
    this.#unsubscribeResize?.();
    this.#unsubscribeResize = null;
    this.#screen.leave();
    this.#resolveStart = null;
    this.#rejectStart = null;
  }
}
