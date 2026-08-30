/**
 * The TUI's single state tree (contract section O).
 *
 * `TuiRuntime` owns the render loop; everything that loop needs to decide
 * *what* to draw lives here as one immutable `AppState`, updated only by
 * `reduce`. Keeping `reduce` pure — no IO, no `Date.now()`, no socket state —
 * is what makes the seven views testable without a live loop process: a view
 * only ever sees `ViewContext.state`, never `Session` directly.
 *
 * Two loops (repo + intake) are modeled as `LoopPane`s rather than two
 * separate trees, because `overview` renders both at once and every other
 * view needs "the other one" reachable for the `L` cycle-focus key.
 */

import type {
  ControlOp,
  GlobalConfig,
  LoopHandle,
  LoopId,
  LoopKind,
  LoopSnapshot,
} from "@foreman/core";

export interface LogLine {
  seq: number;
  at: string;
  level: "info" | "warn" | "error";
  loopId: LoopId;
  line: string;
}

export type ConnectionState = "connecting" | "live" | "file" | "offline" | "error";

export interface LoopPane {
  id: LoopId;
  kind: LoopKind;
  label: string;
  handle: LoopHandle;
  snapshot: LoopSnapshot | null;
  connection: ConnectionState;
  error: string | null;
  busy: string | null;
}

export interface Toast {
  id: number;
  kind: "info" | "ok" | "warn" | "danger";
  message: string;
  at: number;
}

/**
 * A control op a confirm modal defers until the operator answers it.
 *
 * `onConfirm` alone cannot express this: it is an `Action`, and `reduce` is
 * pure, so a store action can never reach `ctx.command`. Without this field a
 * view had to fire the mutation on the keypress that *opened* the modal,
 * which made every confirm decorative — `x` killed the agent before you were
 * asked, and `g` raised autonomy to `full` before you agreed to it. The host
 * runs the effect once, after `y`/`enter`.
 */
export interface ConfirmEffect {
  loopId: LoopId;
  op: ControlOp;
  params?: Record<string, unknown>;
}

export type ModalState =
  | { kind: "help" }
  | {
      kind: "confirm";
      title: string;
      body: string[];
      confirmLabel: string;
      /** Dispatched after the effect runs. */
      onConfirm?: Action;
      /** Sent to the loop after the operator confirms, never before. */
      effect?: ConfirmEffect;
    }
  | {
      kind: "input";
      title: string;
      label: string;
      value: string;
      placeholder?: string;
      submit: (value: string) => Action;
    }
  | { kind: "detail"; title: string; rows: Array<readonly [string, string]>; body?: string[] };

export interface AppState {
  loops: LoopPane[];
  focusedLoop: number;
  activeView: number;
  viewIds: readonly string[];
  cursor: Record<string, number>;
  scroll: Record<string, number>;
  modal: ModalState | null;
  toasts: Toast[];
  logs: LogLine[];
  logFollow: boolean;
  logFilter: string;
  /** Whether `logs` merges both loops or shows only the focused one — view-local UI state, not config. */
  logsAllLoops: boolean;
  /** The `pipeline` view's id/title substring filter — view-local UI state, not config. */
  pipelineFilter: string;
  settingsEdits: Record<string, string | number | boolean>;
  settingsError: string | null;
  config: GlobalConfig;
  configPath: string;
  repoAlias: string | null;
  team: string | null;
  now: number;
  quitting: boolean;
}

export type Action =
  | { type: "clock"; now: number }
  | { type: "setView"; index: number }
  | { type: "nextView" }
  | { type: "prevView" }
  | { type: "focusLoop"; index: number }
  | { type: "cycleLoop" }
  | { type: "moveCursor"; view: string; delta: number; max: number }
  | { type: "setCursor"; view: string; index: number }
  | { type: "setScroll"; view: string; scroll: number }
  | { type: "loops"; handles: LoopHandle[] }
  | { type: "snapshot"; loopId: LoopId; snapshot: LoopSnapshot }
  | { type: "connection"; loopId: LoopId; connection: ConnectionState; error?: string | null }
  | { type: "log"; lines: LogLine[] }
  | { type: "busy"; loopId: LoopId; op: string | null }
  | { type: "toast"; kind: Toast["kind"]; message: string }
  | { type: "dismissToast"; id: number }
  | { type: "openModal"; modal: ModalState }
  | { type: "closeModal" }
  | { type: "modalInput"; value: string }
  | { type: "setLogFollow"; follow: boolean }
  | { type: "setLogFilter"; filter: string }
  | { type: "setLogsAllLoops"; value: boolean }
  | { type: "setPipelineFilter"; filter: string }
  | { type: "editSetting"; key: string; value: string | number | boolean }
  | { type: "deleteSettingEdit"; key: string }
  | { type: "clearSettingEdits" }
  | { type: "settingsError"; message: string | null }
  | { type: "config"; config: GlobalConfig }
  | { type: "quit" };

const TOAST_TTL_MS = 4000;
const LOG_CAP = 2000;

let nextToastId = 1;

export function initialState(input: {
  config: GlobalConfig;
  configPath: string;
  repoAlias: string | null;
  team: string | null;
  viewIds: readonly string[];
  now: number;
}): AppState {
  return {
    loops: [],
    focusedLoop: 0,
    activeView: 0,
    viewIds: input.viewIds,
    cursor: {},
    scroll: {},
    modal: null,
    toasts: [],
    logs: [],
    logFollow: true,
    logFilter: "",
    logsAllLoops: false,
    pipelineFilter: "",
    settingsEdits: {},
    settingsError: null,
    config: input.config,
    configPath: input.configPath,
    repoAlias: input.repoAlias,
    team: input.team,
    now: input.now,
    quitting: false,
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function mergeHandle(pane: LoopPane | undefined, handle: LoopHandle): LoopPane {
  if (!pane) {
    return {
      id: handle.id,
      kind: handle.kind,
      label: handle.label,
      handle,
      snapshot: handle.status?.snapshot ?? null,
      connection: "connecting",
      error: null,
      busy: null,
    };
  }
  return { ...pane, handle, label: handle.label, kind: handle.kind };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "clock": {
      const toasts = state.toasts.filter((toast) => action.now - toast.at < TOAST_TTL_MS);
      if (toasts.length === state.toasts.length && state.now === action.now) {
        return { ...state, now: action.now };
      }
      return { ...state, now: action.now, toasts };
    }

    case "setView":
      return { ...state, activeView: clampIndex(action.index, state.viewIds.length) };

    case "nextView":
      return {
        ...state,
        activeView: state.viewIds.length === 0 ? 0 : (state.activeView + 1) % state.viewIds.length,
      };

    case "prevView":
      return {
        ...state,
        activeView:
          state.viewIds.length === 0
            ? 0
            : (state.activeView - 1 + state.viewIds.length) % state.viewIds.length,
      };

    case "focusLoop":
      return { ...state, focusedLoop: clampIndex(action.index, state.loops.length) };

    case "cycleLoop":
      return {
        ...state,
        focusedLoop: state.loops.length === 0 ? 0 : (state.focusedLoop + 1) % state.loops.length,
      };

    case "moveCursor": {
      const current = state.cursor[action.view] ?? 0;
      const next = Math.min(Math.max(current + action.delta, 0), Math.max(action.max, 0));
      return { ...state, cursor: { ...state.cursor, [action.view]: next } };
    }

    case "setCursor":
      return { ...state, cursor: { ...state.cursor, [action.view]: Math.max(action.index, 0) } };

    case "setScroll":
      return { ...state, scroll: { ...state.scroll, [action.view]: Math.max(action.scroll, 0) } };

    /*
     * An upsert, not a replace: `Session` polls each loop's handle on its own
     * timer and dispatches that one handle, so treating `handles` as the whole
     * list would delete every pane it omits — and re-create it, back at
     * `connecting`, on the next poll of the other loop. Panes are keyed by id
     * and keep their live snapshot, connection and busy state; an id not
     * already present is appended.
     */
    case "loops": {
      const loops = state.loops.map((pane) => {
        const handle = action.handles.find((candidate) => candidate.id === pane.id);
        return handle ? mergeHandle(pane, handle) : pane;
      });
      for (const handle of action.handles) {
        if (!loops.some((pane) => pane.id === handle.id)) loops.push(mergeHandle(undefined, handle));
      }
      return { ...state, loops, focusedLoop: clampIndex(state.focusedLoop, loops.length) };
    }

    case "snapshot": {
      const loops = state.loops.map((pane) => {
        if (pane.id !== action.loopId) return pane;
        const connection = pane.connection === "connecting" ? "live" : pane.connection;
        return { ...pane, snapshot: action.snapshot, connection, error: null };
      });
      return { ...state, loops };
    }

    case "connection": {
      const loops = state.loops.map((pane) =>
        pane.id === action.loopId
          ? { ...pane, connection: action.connection, error: action.error ?? null }
          : pane,
      );
      return { ...state, loops };
    }

    case "log": {
      const merged = state.logs.concat(action.lines);
      const logs = merged.length > LOG_CAP ? merged.slice(merged.length - LOG_CAP) : merged;
      return { ...state, logs };
    }

    case "busy": {
      const loops = state.loops.map((pane) =>
        pane.id === action.loopId ? { ...pane, busy: action.op } : pane,
      );
      return { ...state, loops };
    }

    case "toast": {
      const toast: Toast = { id: nextToastId++, kind: action.kind, message: action.message, at: state.now };
      return { ...state, toasts: [...state.toasts, toast] };
    }

    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };

    case "openModal":
      return { ...state, modal: action.modal };

    case "closeModal":
      return { ...state, modal: null };

    case "modalInput": {
      if (!state.modal || state.modal.kind !== "input") return state;
      return { ...state, modal: { ...state.modal, value: action.value } };
    }

    case "setLogFollow":
      return { ...state, logFollow: action.follow };

    case "setLogFilter":
      return { ...state, logFilter: action.filter };

    case "setLogsAllLoops":
      return { ...state, logsAllLoops: action.value };

    case "setPipelineFilter":
      return { ...state, pipelineFilter: action.filter };

    case "editSetting":
      return { ...state, settingsEdits: { ...state.settingsEdits, [action.key]: action.value } };

    case "deleteSettingEdit": {
      if (!(action.key in state.settingsEdits)) return state;
      const settingsEdits = { ...state.settingsEdits };
      delete settingsEdits[action.key];
      return { ...state, settingsEdits };
    }

    case "clearSettingEdits":
      return { ...state, settingsEdits: {}, settingsError: null };

    case "settingsError":
      return { ...state, settingsError: action.message };

    case "config":
      return { ...state, config: action.config };

    case "quit":
      return { ...state, quitting: true };

    default:
      return state;
  }
}

export function focusedPane(state: AppState): LoopPane | null {
  return state.loops[state.focusedLoop] ?? null;
}

export function paneById(state: AppState, id: LoopId): LoopPane | null {
  return state.loops.find((pane) => pane.id === id) ?? null;
}

export function cursorFor(state: AppState, view: string): number {
  return state.cursor[view] ?? 0;
}

export function scrollFor(state: AppState, view: string): number {
  return state.scroll[view] ?? 0;
}

/** Test-only: resets the module-scoped toast id counter so assertions on exact ids are reproducible. */
export function resetToastIdForTest(): void {
  nextToastId = 1;
}
