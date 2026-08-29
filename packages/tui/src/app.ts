/**
 * The `TuiHost`: chrome, tab routing, the modal stack, toasts, and every
 * global key binding.
 *
 * Views own only their body; everything an operator expects on every screen
 * (which loop is focused, how to quit, how to reach help, how to
 * start/stop/pause/tick/raise-stage) lives here exactly once. Confirmation
 * for anything destructive or autonomy-raising is centralized the same way —
 * a view never opens its own confirm modal for a control op, it calls
 * `ctx.command`/`ctx.startLoop` and the modal (when one is needed) is a
 * global key's job, so an operator never has to remember which screen
 * requires confirmation and which does not.
 */

import type { Canvas, Key, Rect, Theme } from "@foreman/core";
import { keyHints, kvRows, matchesKey, modal, splitVertical, tabsBar, wrapText } from "@foreman/core";
import type { Action, AppState, LoopPane, Toast } from "./store.ts";
import { cursorFor, focusedPane, reduce } from "./store.ts";
import type { View, ViewContext } from "./view.ts";
import type { Session } from "./session.ts";

const GLOBAL_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["?", "help"],
  ["tab", "view"],
  ["L", "loop"],
  ["s", "start"],
  ["S", "stop"],
  ["p", "pause/resume"],
  ["t", "tick"],
  ["g", "stage"],
  ["q", "quit"],
];

export class TuiHost {
  #state: AppState;
  #views: readonly View[];
  #theme: Theme;
  #session: Session;
  #dispatch: (action: Action) => void;
  #tick = 0;
  #suspend: <T>(fn: () => Promise<T>) => Promise<T>;
  #requestRender: () => void;
  #quit: (code?: number) => void;

  constructor(options: {
    state: AppState;
    views: readonly View[];
    theme: Theme;
    session: Session;
    suspend: <T>(fn: () => Promise<T>) => Promise<T>;
    requestRender: () => void;
    quit: (code?: number) => void;
  }) {
    this.#state = options.state;
    this.#views = options.views;
    this.#theme = options.theme;
    this.#session = options.session;
    this.#suspend = options.suspend;
    this.#requestRender = options.requestRender;
    this.#quit = options.quit;
    this.#dispatch = (action) => {
      this.#state = reduce(this.#state, action);
      this.#requestRender();
    };
  }

  get state(): AppState {
    return this.#state;
  }

  /** Entry point for actions arriving from outside the render/key loop — `Session` pushes here. */
  dispatch(action: Action): void {
    this.#dispatch(action);
  }

  #context(): ViewContext {
    return {
      state: this.#state,
      theme: this.#theme,
      tick: this.#tick,
      dispatch: this.#dispatch,
      command: (loopId, op, params) => {
        void this.#session.send(loopId, op, params);
      },
      startLoop: (loopId) => {
        void this.#session.ensureRunning(loopId);
      },
      toast: (kind, message) => this.#dispatch({ type: "toast", kind, message }),
      suspend: this.#suspend,
      requestRender: this.#requestRender,
      openUrl: (url) => {
        void Bun.spawn(["open", url]).exited.catch(() => {});
      },
    };
  }

  render(frame: { canvas: Canvas; rect: Rect; tick: number }): void {
    this.#tick = frame.tick;
    const { canvas, rect } = frame;
    const ctx = this.#context();
    canvas.clear();

    const [header, tabs, body, footer] = splitVertical(rect, [
      { fixed: 1 },
      { fixed: 1 },
      { flex: 1 },
      { fixed: 1 },
    ]) as [Rect, Rect, Rect, Rect];

    this.#renderHeader(canvas, header, ctx);
    this.#renderTabs(canvas, tabs, ctx);

    const view = this.#views[this.#state.activeView];
    if (view && body.width > 0 && body.height > 0) view.render(canvas, body, ctx);

    this.#renderFooter(canvas, footer, ctx, view);
    this.#renderToasts(canvas, rect, ctx);

    if (this.#state.modal) this.#renderModal(canvas, rect, ctx);
  }

  #renderHeader(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const theme = this.#theme;
    const pane = focusedPane(this.#state);
    const parts = [theme.tone("header", "foreman")];
    if (this.#state.repoAlias) parts.push(this.#state.repoAlias);
    if (this.#state.team) parts.push(this.#state.team);
    if (pane) {
      parts.push(pane.label);
      const runtime = pane.snapshot?.runtime;
      if (runtime) {
        parts.push(runtime.dispatcher);
        if (runtime.state === "paused" || runtime.state === "stopped") {
          parts.push(theme.tone("warn", runtime.state));
        }
      }
    }
    canvas.text(1, rect.y, parts.join("  "), theme.sgr());
    const clock = new Date(this.#state.now).toTimeString().slice(0, 8);
    canvas.text(Math.max(1, rect.width - clock.length - 1), rect.y, clock, theme.toneSgr("muted"));
  }

  #renderTabs(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const labels = this.#views.map((view) => view.title);
    const badges = this.#views.map((view) => view.badge?.(ctx) ?? null);
    tabsBar(canvas, rect, { theme: this.#theme, labels, active: this.#state.activeView, badges });
  }

  #renderFooter(canvas: Canvas, rect: Rect, ctx: ViewContext, view: View | undefined): void {
    const hints = [...(view?.hints(ctx) ?? []), ...GLOBAL_HINTS];
    const text = keyHints(this.#theme, hints, rect.width);
    canvas.text(1, rect.y, text, this.#theme.sgr());
  }

  #renderToasts(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const toasts = this.#state.toasts.slice(-4);
    let y = rect.y + rect.height - 2;
    for (let i = toasts.length - 1; i >= 0; i -= 1) {
      const toast = toasts[i];
      if (!toast || y < 1) break;
      const tone = toast.kind === "danger" ? "danger" : toast.kind === "warn" ? "warn" : toast.kind === "ok" ? "ok" : "info";
      const text = ` ${toast.message} `;
      const x = Math.max(1, rect.width - text.length - 1);
      canvas.text(x, y, text, this.#theme.toneSgr(tone));
      y -= 1;
    }
  }

  #renderModal(canvas: Canvas, rect: Rect, ctx: ViewContext): void {
    const modalState = this.#state.modal;
    if (!modalState) return;
    const theme = this.#theme;

    if (modalState.kind === "help") {
      const inner = modal(canvas, rect, { theme, title: "keymap", width: 60, height: 20, footer: "esc close" });
      kvRows(canvas, inner, {
        theme,
        entries: GLOBAL_HINTS.map(([key, label]) => [key, label] as const),
      });
      return;
    }

    if (modalState.kind === "confirm") {
      const height = Math.min(12, modalState.body.length + 6);
      const inner = modal(canvas, rect, {
        theme,
        title: modalState.title,
        width: 60,
        height,
        footer: `y ${modalState.confirmLabel} · n cancel`,
      });
      const lines = wrapText(modalState.body.join("\n"), inner.width);
      lines.forEach((line, index) => canvas.text(inner.x, inner.y + index, line, theme.sgr()));
      return;
    }

    if (modalState.kind === "input") {
      const inner = modal(canvas, rect, { theme, title: modalState.title, width: 60, height: 6, footer: "enter submit · esc cancel" });
      canvas.text(inner.x, inner.y, modalState.label, theme.toneSgr("muted"));
      canvas.text(inner.x, inner.y + 1, modalState.value || modalState.placeholder || "", theme.sgr());
      return;
    }

    if (modalState.kind === "detail") {
      const inner = modal(canvas, rect, { theme, title: modalState.title, width: 70, height: 20, footer: "esc close" });
      const [rowsArea, bodyArea] = splitVertical(inner, [{ flex: 1 }, { fixed: modalState.body?.length ?? 0 }]) as [
        Rect,
        Rect,
      ];
      kvRows(canvas, rowsArea, { theme, entries: modalState.rows, scroll: cursorFor(this.#state, "modal") });
      if (modalState.body) {
        modalState.body.forEach((line, index) => canvas.text(bodyArea.x, bodyArea.y + index, line, theme.toneSgr("muted")));
      }
    }
    void ctx;
  }

  handleKey(key: Key): void {
    const ctx = this.#context();

    if (this.#state.modal) {
      this.#handleModalKey(key, ctx);
      return;
    }

    const view = this.#views[this.#state.activeView];
    if (view?.handleKey(key, ctx)) return;

    if (matchesKey(key, "?")) {
      this.#dispatch({ type: "openModal", modal: { kind: "help" } });
      return;
    }
    if (matchesKey(key, "tab")) {
      this.#dispatch({ type: "nextView" });
      return;
    }
    if (matchesKey(key, "shift-tab") || matchesKey(key, "backtab")) {
      this.#dispatch({ type: "prevView" });
      return;
    }
    for (let i = 0; i < 7; i += 1) {
      if (matchesKey(key, String(i + 1))) {
        this.#dispatch({ type: "setView", index: i });
        return;
      }
    }
    if (matchesKey(key, "L")) {
      this.#dispatch({ type: "cycleLoop" });
      return;
    }
    if (matchesKey(key, "r")) {
      void this.#session.refresh();
      return;
    }
    if (matchesKey(key, "s")) {
      const pane = focusedPane(this.#state);
      if (pane) ctx.startLoop(pane.id);
      return;
    }
    if (matchesKey(key, "S")) {
      const pane = focusedPane(this.#state);
      if (pane) this.#confirmStop(pane);
      return;
    }
    if (matchesKey(key, "p")) {
      const pane = focusedPane(this.#state);
      if (pane) {
        const paused = pane.snapshot?.runtime.state === "paused";
        ctx.command(pane.id, paused ? "resume" : "pause");
      }
      return;
    }
    if (matchesKey(key, "t")) {
      const pane = focusedPane(this.#state);
      if (pane) ctx.command(pane.id, "tick");
      return;
    }
    if (matchesKey(key, "g")) {
      const pane = focusedPane(this.#state);
      if (pane) this.#cycleStage(pane);
      return;
    }
    if (matchesKey(key, "ctrl-c") || matchesKey(key, "q")) {
      this.#confirmQuit();
    }
  }

  #confirmStop(pane: LoopPane): void {
    this.#dispatch({
      type: "openModal",
      modal: {
        kind: "confirm",
        title: `Stop ${pane.label}`,
        body: [`This stops the ${pane.label} loop process.`],
        confirmLabel: "Stop",
        effect: { loopId: pane.id, op: "stop", params: { mode: "graceful" } },
        onConfirm: { type: "toast", kind: "info", message: `stopping ${pane.label}` },
      },
    });
  }

  #cycleStage(pane: LoopPane): void {
    const current = pane.snapshot?.runtime.stage ?? "dry-run";
    const next = current === "dry-run" ? "read-only" : current === "read-only" ? "full" : "dry-run";
    if (next === "full") {
      this.#dispatch({
        type: "openModal",
        modal: {
          kind: "confirm",
          title: `Raise ${pane.label} to full`,
          body: [
            `This lets ${pane.label} dispatch agents that write code.`,
            "Confirm you intend to raise autonomy for this loop.",
          ],
          confirmLabel: "Raise to full",
          effect: { loopId: pane.id, op: "setStage", params: { stage: "full" } },
          onConfirm: { type: "toast", kind: "warn", message: `${pane.label} raised to full` },
        },
      });
    } else {
      void this.#session.send(pane.id, "setStage", { stage: next });
    }
  }

  #confirmQuit(): void {
    const running = this.#state.loops.some((pane) => pane.handle.running);
    if (!running) {
      this.#quit(0);
      return;
    }
    this.#dispatch({
      type: "openModal",
      modal: {
        kind: "confirm",
        title: "Quit foreman tui",
        body: ["The loops keep running after this closes.", "Quit the command center?"],
        confirmLabel: "Quit",
        onConfirm: { type: "quit" },
      },
    });
  }

  #handleModalKey(key: Key, ctx: ViewContext): void {
    const modal = this.#state.modal;
    if (!modal) return;

    if (modal.kind === "help") {
      if (matchesKey(key, "escape") || matchesKey(key, "?") || matchesKey(key, "enter")) {
        this.#dispatch({ type: "closeModal" });
      }
      return;
    }

    if (modal.kind === "confirm") {
      if (matchesKey(key, "y") || matchesKey(key, "enter")) {
        const { onConfirm, effect } = modal;
        this.#dispatch({ type: "closeModal" });
        // The effect first: `onConfirm` is often the bookkeeping that follows
        // it, e.g. clearing the settings edits the patch just persisted.
        if (effect) ctx.command(effect.loopId, effect.op, effect.params);
        if (onConfirm) {
          if (onConfirm.type === "quit") this.#quit(0);
          else this.#dispatch(onConfirm);
        }
      } else if (matchesKey(key, "n") || matchesKey(key, "escape")) {
        this.#dispatch({ type: "closeModal" });
      }
      return;
    }

    if (modal.kind === "input") {
      if (matchesKey(key, "escape")) {
        this.#dispatch({ type: "closeModal" });
      } else if (matchesKey(key, "enter")) {
        const action = modal.submit(modal.value);
        this.#dispatch({ type: "closeModal" });
        this.#dispatch(action);
      } else if (matchesKey(key, "backspace")) {
        this.#dispatch({ type: "modalInput", value: modal.value.slice(0, -1) });
      } else if (key.char) {
        this.#dispatch({ type: "modalInput", value: modal.value + key.char });
      }
      return;
    }

    if (modal.kind === "detail") {
      if (matchesKey(key, "escape") || matchesKey(key, "enter")) {
        this.#dispatch({ type: "closeModal" });
      } else if (matchesKey(key, "up")) {
        this.#dispatch({ type: "setScroll", view: "modal", scroll: Math.max(0, cursorFor(this.#state, "modal") - 1) });
      } else if (matchesKey(key, "down")) {
        this.#dispatch({ type: "setScroll", view: "modal", scroll: cursorFor(this.#state, "modal") + 1 });
      }
      void ctx;
    }
  }
}
