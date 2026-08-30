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
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  type ControlEvent,
  type ControlOp,
  type EmittableEvent,
  type ControlRequest,
  ControlRequestSchema,
  type ControlResponse,
  encodeFrame,
  FrameDecoder,
  isLoopStage,
  type LoopSnapshot,
  type LoopStage,
  type ServerInfo,
} from "./protocol.ts";
import { probeSocket } from "./client.ts";

/** Cap on a stalled connection's queued-but-unwritten frames; past this the connection is unsalvageable and dropped. */
const MAX_QUEUED_WRITE_BYTES = 8 * 1024 * 1024;

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
  /** Where this loop's `loop.lock` actually lives; defaults to the socket's own directory. Pass this explicitly when the socket path falls back to a shared temp directory (see `paths.ts`), so `describeHolder` still finds the real lock. */
  lockPath?: string;
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
  /** Frames that couldn't be written synchronously because the socket's send buffer is full; flushed on `drain`. */
  writeQueue: string[];
  queuedBytes: number;
  paused: boolean;
}

/** Reads the loop's `loop.lock`, when one exists, so `listen()` can name the pid holding a live socket. */
function describeHolder(lockPath: string): string {
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
  readonly #lockPath: string;
  readonly #handlers: ControlHandlers;
  readonly #info: ServerInfo;
  readonly #logBufferSize: number;
  readonly #log: (message: string) => void;
  readonly #connections = new Set<Connection>();
  #server: Server | null = null;
  #bound = false;
  #seq = 0;
  #logRing: LogRecord[] = [];

  constructor(options: ControlServerOptions) {
    this.#socketPath = options.socketPath;
    this.#lockPath = options.lockPath ?? `${dirname(options.socketPath)}/loop.lock`;
    this.#handlers = options.handlers;
    this.#info = options.info;
    this.#logBufferSize = options.logBufferSize ?? 500;
    this.#log = options.log ?? (() => {});
  }

  async listen(): Promise<void> {
    if (existsSync(this.#socketPath)) {
      const alive = await probeSocket(this.#socketPath);
      if (alive) {
        throw new Error(`control socket ${this.#socketPath} is already held by ${describeHolder(this.#lockPath)}`);
      }
      unlinkSync(this.#socketPath);
    }
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    // Bind private from the first instant: a collaborative `umask 002` would otherwise leave a
    // group-writable socket file for the window between `listen()` resolving and the belt-and-
    // braces `chmodSync` below (FOREMAN-SEC-002).
    const previousUmask = process.umask(0o077);
    try {
      server.listen(this.#socketPath, () => {
        server.removeListener("error", reject);
        this.#bound = true;
        resolve();
      });
      await promise;
    } finally {
      process.umask(previousUmask);
    }
    chmodSync(this.#socketPath, 0o600);
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
    // Only unlink the socket file when this instance actually bound it — an EADDRINUSE failure
    // during `listen()` never sets `#bound`, so cleanup here must not delete the live peer's
    // socket out from under it.
    if (this.#bound && existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }

  broadcast(event: EmittableEvent): void {
    const stamped = { ...event, seq: ++this.#seq, at: new Date().toISOString() } as ControlEvent;
    const frame = encodeFrame(stamped);
    for (const connection of this.#connections) {
      if (!connection.subscribed) continue;
      this.#send(connection, frame);
    }
  }

  publishLog(level: "info" | "warn" | "error", line: string): void {
    const record: LogRecord = { seq: ++this.#seq, at: new Date().toISOString(), level, line };
    this.#logRing.push(record);
    if (this.#logRing.length > this.#logBufferSize) this.#logRing.shift();
    const frame = encodeFrame({ event: "log", ...record });
    for (const connection of this.#connections) {
      if (!connection.subscribed) continue;
      this.#send(connection, frame);
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
    const connection: Connection = {
      socket,
      decoder: new FrameDecoder(),
      subscribed: false,
      writeQueue: [],
      queuedBytes: 0,
      paused: false,
    };
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

  /**
   * Writes a frame, or queues it when the kernel send buffer is full. `socket.write() === false`
   * is ordinary backpressure, not an error — destroying the connection on it (the prior behavior)
   * dropped the payload outright on any snapshot or broadcast above the socket buffer size. The
   * queue is bounded so a client that stops reading entirely still gets dropped eventually.
   */
  #send(connection: Connection, frame: string): void {
    if (connection.paused) {
      this.#enqueue(connection, frame);
      return;
    }
    const ok = connection.socket.write(frame);
    if (!ok) {
      connection.paused = true;
      connection.socket.once("drain", () => this.#drain(connection));
    }
  }

  #enqueue(connection: Connection, frame: string): void {
    connection.writeQueue.push(frame);
    connection.queuedBytes += Buffer.byteLength(frame);
    if (connection.queuedBytes > MAX_QUEUED_WRITE_BYTES) {
      connection.socket.destroy();
    }
  }

  #drain(connection: Connection): void {
    connection.paused = false;
    while (connection.writeQueue.length > 0) {
      const frame = connection.writeQueue.shift() as string;
      connection.queuedBytes -= Buffer.byteLength(frame);
      const ok = connection.socket.write(frame);
      if (!ok) {
        connection.paused = true;
        connection.socket.once("drain", () => this.#drain(connection));
        return;
      }
    }
  }

  #handleFrame(connection: Connection, frame: unknown): void {
    if (!Value.Check(ControlRequestSchema, frame)) {
      // protocol.ts's contract: a malformed frame fails loudly, never silently misrenders. Answer
      // with an error when the frame at least carries an id the caller can match; otherwise there
      // is nothing to address the response to.
      const id = (frame as { id?: unknown } | null)?.id;
      if (typeof id === "number") {
        this.#send(
          connection,
          encodeFrame({ id, ok: false, error: { code: "invalid-frame", message: "malformed control request" } }),
        );
      }
      return;
    }
    void this.#dispatch(connection, frame);
  }

  async #dispatch(connection: Connection, request: ControlRequest): Promise<void> {
    const response = await this.#run(connection, request.op, request.params);
    const payload: ControlResponse = { id: request.id, ...response } as ControlResponse;
    this.#send(connection, encodeFrame(payload));
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
        case "logs": {
          const sinceSeq = params?.sinceSeq ?? 0;
          if (typeof sinceSeq !== "number" || !Number.isFinite(sinceSeq) || sinceSeq < 0) {
            return {
              ok: false,
              error: { code: "invalid-params", message: `invalid sinceSeq: ${String(sinceSeq)}` },
            };
          }
          return { ok: true, data: { recentLogs: this.recentLogs(sinceSeq) } };
        }
        case "snapshot":
          return { ok: true, data: await this.#handlers.snapshot() };
        case "pause":
          await this.#handlers.pause();
          return { ok: true };
        case "resume":
          await this.#handlers.resume();
          return { ok: true };
        case "stop": {
          const mode = params?.mode ?? "graceful";
          if (mode !== "graceful" && mode !== "now") {
            return { ok: false, error: { code: "invalid-params", message: `invalid stop mode: ${String(mode)}` } };
          }
          await this.#handlers.stop(mode);
          return { ok: true };
        }
        case "tick": {
          const workers = params?.workers;
          if (
            workers !== undefined &&
            (!Array.isArray(workers) || !workers.every((worker) => typeof worker === "string"))
          ) {
            return {
              ok: false,
              error: { code: "invalid-params", message: `invalid workers: ${JSON.stringify(workers)}` },
            };
          }
          await this.#handlers.tick(workers as readonly string[] | undefined);
          return { ok: true };
        }
        case "setStage": {
          const stage = params?.stage;
          if (!isLoopStage(stage)) {
            return { ok: false, error: { code: "invalid-params", message: `invalid stage: ${String(stage)}` } };
          }
          await this.#handlers.setStage(stage);
          return { ok: true };
        }
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
