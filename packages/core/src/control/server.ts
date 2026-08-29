/**
 * `ControlServer` (SPEC §17).
 *
 * The loop process's half of the control plane: a unix socket that answers
 * requests from any number of connected clients (the TUI, `foreman status`,
 * a future CLI verb) and pushes events to whichever of them subscribed.
 *
 * Every request is user input from the operator's own tooling, but it still
 * crosses a process boundary — a bad frame, an unknown op, or a handler that
 * throws must degrade to an error response, never crash the loop that is
 * mid-tick. `listen()` treats a stale socket file (left by a killed process)
 * as reclaimable but refuses to steal one from a server that is still
 * answering, so two loops for the same repo can never both claim it.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ControlEvent,
  type ControlOp,
  type EmittableEvent,
  type ControlRequest,
  type ControlResponse,
  encodeFrame,
  FrameDecoder,
  type LoopSnapshot,
  type LoopStage,
  type ServerInfo,
} from "./protocol.ts";
import { probeSocket } from "./client.ts";

export interface ControlHandlers {
  snapshot(): Promise<LoopSnapshot> | LoopSnapshot;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  stop(mode: "graceful" | "now"): Promise<void> | void;
  tick(workers?: readonly string[]): Promise<void> | void;
  setStage(stage: LoopStage): Promise<void> | void;
  patchConfig(patch: unknown): Promise<void> | void;
  reload(): Promise<void> | void;
  attachAgent(dispatchId: string): Promise<void> | void;
  killAgent(dispatchId: string): Promise<void> | void;
}

export interface ControlServerOptions {
  socketPath: string;
  handlers: ControlHandlers;
  info: ServerInfo;
  logBufferSize?: number;
  log?: (message: string) => void;
}

interface LogRecord {
  seq: number;
  at: string;
  level: "info" | "warn" | "error";
  line: string;
}

interface Connection {
  socket: Socket;
  decoder: FrameDecoder;
  subscribed: boolean;
}

/** Reads the sibling `loop.lock` next to the socket, when one exists, so `listen()` can name the pid holding a live socket. */
function describeHolder(socketPath: string): string {
  const lockPath = `${dirname(socketPath)}/loop.lock`;
  if (!existsSync(lockPath)) return "another process";
  try {
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    return typeof info.pid === "number" ? `pid ${info.pid}` : "another process";
  } catch {
    return "another process";
  }
}

export class ControlServer {
  readonly #socketPath: string;
  readonly #handlers: ControlHandlers;
  readonly #info: ServerInfo;
  readonly #logBufferSize: number;
  readonly #log: (message: string) => void;
  readonly #connections = new Set<Connection>();
  #server: Server | null = null;
  #seq = 0;
  #logRing: LogRecord[] = [];

  constructor(options: ControlServerOptions) {
    this.#socketPath = options.socketPath;
    this.#handlers = options.handlers;
    this.#info = options.info;
    this.#logBufferSize = options.logBufferSize ?? 500;
    this.#log = options.log ?? (() => {});
  }

  async listen(): Promise<void> {
    if (existsSync(this.#socketPath)) {
      const alive = await probeSocket(this.#socketPath);
      if (alive) {
        throw new Error(
          `control socket ${this.#socketPath} is already held by ${describeHolder(this.#socketPath)}`,
        );
      }
      unlinkSync(this.#socketPath);
    }
    mkdirSync(dirname(this.#socketPath), { recursive: true });
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(this.#socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
    await promise;
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.socket.destroy();
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    }
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }

  broadcast(event: EmittableEvent): void {
    const stamped = { ...event, seq: ++this.#seq, at: new Date().toISOString() } as ControlEvent;
    const frame = encodeFrame(stamped);
    for (const connection of this.#connections) {
      if (!connection.subscribed) continue;
      const ok = connection.socket.write(frame);
      if (!ok) connection.socket.destroy();
    }
  }

  publishLog(level: "info" | "warn" | "error", line: string): void {
    const record: LogRecord = { seq: ++this.#seq, at: new Date().toISOString(), level, line };
    this.#logRing.push(record);
    if (this.#logRing.length > this.#logBufferSize) this.#logRing.shift();
    const frame = encodeFrame({ event: "log", ...record });
    for (const connection of this.#connections) {
      if (!connection.subscribed) continue;
      const ok = connection.socket.write(frame);
      if (!ok) connection.socket.destroy();
    }
  }

  recentLogs(sinceSeq = 0, limit = this.#logBufferSize): Array<{ seq: number; at: string; level: string; line: string }> {
    return this.#logRing.filter((record) => record.seq > sinceSeq).slice(-limit);
  }

  get clientCount(): number {
    return this.#connections.size;
  }

  get listening(): boolean {
    return this.#server !== null;
  }

  #handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
    const connection: Connection = { socket, decoder: new FrameDecoder(), subscribed: false };
    this.#connections.add(connection);
    socket.on("data", (chunk: string) => {
      const frames = connection.decoder.push(chunk);
      for (const frame of frames) this.#handleFrame(connection, frame);
    });
    socket.on("error", () => {
      this.#connections.delete(connection);
    });
    socket.on("close", () => {
      this.#connections.delete(connection);
    });
  }

  #handleFrame(connection: Connection, frame: unknown): void {
    const request = frame as Partial<ControlRequest>;
    if (typeof request.id !== "number" || typeof request.op !== "string") return;
    void this.#dispatch(connection, request as ControlRequest);
  }

  async #dispatch(connection: Connection, request: ControlRequest): Promise<void> {
    const response = await this.#run(connection, request.op, request.params);
    const payload: ControlResponse = { id: request.id, ...response } as ControlResponse;
    const ok = connection.socket.write(encodeFrame(payload));
    if (!ok) connection.socket.destroy();
  }

  async #run(
    connection: Connection,
    op: ControlOp,
    params: Record<string, unknown> | undefined,
  ): Promise<{ ok: true; data?: unknown } | { ok: false; error: { code: string; message: string } }> {
    try {
      switch (op) {
        case "hello":
          return { ok: true, data: this.#info };
        case "subscribe":
          connection.subscribed = true;
          return { ok: true, data: { recentLogs: this.recentLogs() } };
        case "logs":
          return { ok: true, data: { recentLogs: this.recentLogs(Number(params?.sinceSeq ?? 0)) } };
        case "snapshot":
          return { ok: true, data: await this.#handlers.snapshot() };
        case "pause":
          await this.#handlers.pause();
          return { ok: true };
        case "resume":
          await this.#handlers.resume();
          return { ok: true };
        case "stop":
          await this.#handlers.stop((params?.mode as "graceful" | "now" | undefined) ?? "graceful");
          return { ok: true };
        case "tick":
          await this.#handlers.tick(params?.workers as readonly string[] | undefined);
          return { ok: true };
        case "setStage":
          await this.#handlers.setStage(params?.stage as LoopStage);
          return { ok: true };
        case "patchConfig":
          await this.#handlers.patchConfig(params?.patch);
          return { ok: true };
        case "reload":
          await this.#handlers.reload();
          return { ok: true };
        case "attachAgent":
          await this.#handlers.attachAgent(String(params?.dispatchId ?? ""));
          return { ok: true };
        case "killAgent":
          await this.#handlers.killAgent(String(params?.dispatchId ?? ""));
          return { ok: true };
        default:
          return { ok: false, error: { code: "unknown-op", message: `unknown op: ${op}` } };
      }
    } catch (error) {
      this.#log(`control handler ${op} threw: ${(error as Error).message}`);
      return {
        ok: false,
        error: { code: "handler-error", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
