/**
 * `ControlClient` (SPEC §17).
 *
 * The operator-tooling half of the control plane: connects to a loop's unix
 * socket, exchanges request/response frames keyed by an incrementing id, and
 * routes anything pushed without a matching id — a broadcast event — to
 * whoever subscribed. `probeSocket`/`waitForSocket` exist because "is a loop
 * running" is asked constantly (registry discovery, `foreman status`, the
 * TUI's per-loop connection badge) and must never throw just because nothing
 * is listening yet.
 */

import { createConnection, type Socket } from "node:net";
import {
  type ControlEvent,
  type ControlOp,
  type ControlResponse,
  encodeFrame,
  FrameDecoder,
  type ServerInfo,
} from "./protocol.ts";

export interface ControlClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class ControlClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #subscribers = new Set<(event: ControlEvent) => void>();
  readonly #closeHandlers = new Set<(error: Error | null) => void>();
  #socket: Socket | null = null;
  #nextId = 1;
  #closeNotified = false;
  constructor(options: ControlClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? 2000;
  }

  async connect(): Promise<ServerInfo> {
    const socket = await this.#open();
    this.#socket = socket;
    return this.request<ServerInfo>("hello");
  }

  #open(): Promise<Socket> {
    const { promise, resolve, reject } = Promise.withResolvers<Socket>();
    const socket = createConnection(this.#socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to control socket ${this.#socketPath}`));
    }, this.#timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      this.#closeNotified = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.#onData(chunk));
      socket.on("close", () => this.#onClose(null));
      socket.on("error", (error) => {
        clearTimeout(timer);
        this.#onClose(error);
      });
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const suffix = error.code ? ` (${error.code})` : "";
      reject(new Error(`cannot connect to control socket ${this.#socketPath}${suffix}`));
    });
    return promise;
  }

  #onData(chunk: string): void {
    for (const frame of this.#decoder.push(chunk)) this.#onFrame(frame);
  }

  #onFrame(frame: unknown): void {
    const record = frame as { id?: unknown; event?: unknown };
    if (typeof record.id === "number") {
      this.#onResponse(frame as ControlResponse);
      return;
    }
    if (typeof record.event === "string") {
      for (const subscriber of this.#subscribers) {
        try {
          subscriber(frame as ControlEvent);
        } catch (error) {
          console.error(`control client subscriber threw: ${(error as Error).message}`);
        }
      }
    }
  }

  #onResponse(response: ControlResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.data);
    } else {
      const error = new Error(response.error.message) as Error & { code?: string };
      error.code = response.error.code;
      pending.reject(error);
    }
  }

  #onClose(error: Error | null): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#socket = null;
    for (const pending of this.#pending.values()) {
      pending.reject(error ?? new Error(`control socket ${this.#socketPath} closed`));
    }
    this.#pending.clear();
    for (const handler of this.#closeHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error(`control client close handler threw: ${(err as Error).message}`);
      }
    }
  }

  request<T>(op: ControlOp, params?: Record<string, unknown>): Promise<T> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error("control client is not connected"));
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`control request "${op}" timed out`));
    }, this.#timeoutMs);
    this.#pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.write(encodeFrame({ id, op, params }));
    return promise;
  }

  async subscribe(
    handler: (event: ControlEvent) => void,
    onSubscribed?: (response: { recentLogs: Array<{ seq: number; at: string; level: string; line: string }> }) => void,
  ): Promise<() => void> {
    this.#subscribers.add(handler);
    try {
      const response = await this.request<{ recentLogs: Array<{ seq: number; at: string; level: string; line: string }> }>(
        "subscribe",
      );
      if (onSubscribed) {
        try {
          onSubscribed(response);
        } catch (error) {
          console.error(`control client subscription handler threw: ${(error as Error).message}`);
        }
      }
      return () => {
        this.#subscribers.delete(handler);
      };
    } catch (error) {
      this.#subscribers.delete(handler);
      throw error;
    }
  }

  onClose(handler: (error: Error | null) => void): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/** True when something is listening and speaks the protocol. Never throws. */
export async function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  const client = new ControlClient({ socketPath, timeoutMs });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** Polls until the socket answers `hello` or `timeoutMs` elapses. Returns the info or null. */
export async function waitForSocket(socketPath: string, timeoutMs: number): Promise<ServerInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new ControlClient({ socketPath, timeoutMs: 500 });
    try {
      const info = await client.connect();
      client.close();
      return info;
    } catch {
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}
