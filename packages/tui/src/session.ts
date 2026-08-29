/**
 * The loop connection manager: one `ControlClient` per managed loop, kept
 * alive across restarts.
 *
 * The TUI outlives any single loop process — an operator may start a loop
 * from inside the TUI, or a loop may crash and get restarted by hand while
 * the TUI stays open — so every connection here is self-healing: a closed
 * socket schedules a reconnect with capped backoff instead of surfacing as a
 * dead pane. `status.json` is the fallback when nothing is listening yet
 * (SPEC's belt-and-braces file next to the socket), and `loopHandle` is
 * re-polled independently of the socket so `running`/`pid` stay honest even
 * when the control connection itself is fine.
 *
 * Every action funnels through `onAction` into the pure `reduce` in
 * `store.ts` — nothing here mutates `AppState` directly, so the render loop
 * never observes a half-updated pane.
 */

import type { ControlEvent, ControlOp, GlobalConfig, LoopId, LoopSnapshot } from "@foreman/core";
import { ControlClient, loopHandle, loopPaths, readStatusFile } from "@foreman/core";
import type { Action } from "./store.ts";
import { startLoop } from "./supervise.ts";

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000];
const SNAPSHOT_POLL_MS = 3000;
const HANDLE_POLL_MS = 5000;

interface LoopConnection {
  id: LoopId;
  client: ControlClient | null;
  unsubscribe: (() => void) | null;
  reconnectAttempt: number;
  timers: Set<ReturnType<typeof setTimeout>>;
  intervals: Set<ReturnType<typeof setInterval>>;
  closed: boolean;
}

export interface SessionOptions {
  config: GlobalConfig;
  home?: string;
  loopIds: readonly LoopId[];
  onAction: (action: Action) => void;
  team: string | null;
}

export class Session {
  #config: GlobalConfig;
  #home: string | undefined;
  #loopIds: readonly LoopId[];
  #onAction: (action: Action) => void;
  #team: string | null;
  #connections = new Map<LoopId, LoopConnection>();

  constructor(options: SessionOptions) {
    this.#config = options.config;
    this.#home = options.home;
    this.#loopIds = options.loopIds;
    this.#onAction = options.onAction;
    this.#team = options.team;
  }

  start(): void {
    for (const id of this.#loopIds) {
      const connection: LoopConnection = {
        id,
        client: null,
        unsubscribe: null,
        reconnectAttempt: 0,
        timers: new Set(),
        intervals: new Set(),
        closed: false,
      };
      this.#connections.set(id, connection);
      this.#connect(connection);
      this.#pollSnapshot(connection);
      this.#pollHandle(connection);
    }
  }

  async ensureRunning(id: LoopId): Promise<void> {
    const result = await startLoop(id, { config: this.#config, home: this.#home, team: this.#team });
    this.#onAction({
      type: "toast",
      kind: result.started ? "ok" : result.pid ? "info" : "warn",
      message: `${id}: ${result.message}`,
    });
    const connection = this.#connections.get(id);
    if (connection) this.#connect(connection);
  }

  async send(id: LoopId, op: ControlOp, params?: Record<string, unknown>): Promise<void> {
    const connection = this.#connections.get(id);
    const client = connection?.client;
    this.#onAction({ type: "busy", loopId: id, op });
    try {
      if (!client || !client.connected) throw new Error(`${id} is not connected`);
      await client.request(op, params);
    } catch (error) {
      this.#onAction({ type: "toast", kind: "danger", message: `${id} ${op} failed: ${String(error)}` });
    } finally {
      this.#onAction({ type: "busy", loopId: id, op: null });
    }
  }

  async refresh(): Promise<void> {
    for (const connection of this.#connections.values()) {
      await this.#refreshOne(connection);
    }
  }

  updateConfig(config: GlobalConfig): void {
    this.#config = config;
  }

  close(): void {
    for (const connection of this.#connections.values()) {
      connection.closed = true;
      connection.unsubscribe?.();
      connection.client?.close();
      for (const timer of connection.timers) clearTimeout(timer);
      for (const interval of connection.intervals) clearInterval(interval);
    }
    this.#connections.clear();
  }

  #connect(connection: LoopConnection): void {
    if (connection.closed) return;
    const paths = loopPaths(this.#config, connection.id, this.#home);
    const client = new ControlClient({ socketPath: paths.socket });
    connection.client = client;
    client
      .connect()
      .then(async () => {
        connection.reconnectAttempt = 0;
        this.#onAction({ type: "connection", loopId: connection.id, connection: "live" });
        connection.unsubscribe = await client.subscribe((event) => this.#handleEvent(connection, event));
        client.onClose(() => {
          if (connection.closed) return;
          this.#fallbackToFile(connection);
          this.#scheduleReconnect(connection);
        });
      })
      .catch(() => {
        this.#fallbackToFile(connection);
        this.#scheduleReconnect(connection);
      });
  }

  #scheduleReconnect(connection: LoopConnection): void {
    if (connection.closed) return;
    const step = Math.min(connection.reconnectAttempt, BACKOFF_STEPS_MS.length - 1);
    const delay = BACKOFF_STEPS_MS[step] ?? 8000;
    connection.reconnectAttempt += 1;
    const timer = setTimeout(() => {
      connection.timers.delete(timer);
      this.#connect(connection);
    }, delay);
    connection.timers.add(timer);
  }

  #fallbackToFile(connection: LoopConnection): void {
    const paths = loopPaths(this.#config, connection.id, this.#home);
    const statusFile = readStatusFile(paths.status);
    if (statusFile) {
      this.#onAction({ type: "connection", loopId: connection.id, connection: "file" });
      this.#onAction({ type: "snapshot", loopId: connection.id, snapshot: statusFile.snapshot });
    } else {
      this.#onAction({ type: "connection", loopId: connection.id, connection: "offline" });
    }
  }

  #handleEvent(connection: LoopConnection, event: ControlEvent): void {
    switch (event.event) {
      case "snapshot":
        this.#onAction({ type: "snapshot", loopId: connection.id, snapshot: event.snapshot });
        break;
      case "log":
        this.#onAction({
          type: "log",
          lines: [{ seq: event.seq, at: event.at, level: event.level, loopId: connection.id, line: event.line }],
        });
        break;
      case "state":
      case "tick":
      case "dispatch":
        void this.#refreshOne(connection);
        break;
    }
  }

  #pollSnapshot(connection: LoopConnection): void {
    const interval = setInterval(() => {
      void this.#refreshOne(connection);
    }, SNAPSHOT_POLL_MS);
    connection.intervals.add(interval);
  }

  async #refreshOne(connection: LoopConnection): Promise<void> {
    const client = connection.client;
    if (client?.connected) {
      try {
        const snapshot = await client.request<LoopSnapshot>("snapshot");
        this.#onAction({ type: "snapshot", loopId: connection.id, snapshot });
        return;
      } catch {
        // Falls through to the file fallback below.
      }
    }
    this.#fallbackToFile(connection);
  }

  #pollHandle(connection: LoopConnection): void {
    const poll = async (): Promise<void> => {
      try {
        const handle = await loopHandle(this.#config, connection.id, { home: this.#home });
        this.#onAction({ type: "loops", handles: [handle] });
      } catch {
        // A failed poll leaves the last-known handle in place; nothing to report.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), HANDLE_POLL_MS);
    connection.intervals.add(interval);
  }
}
