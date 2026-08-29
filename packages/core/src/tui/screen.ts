/**
 * Owns the terminal: the alternate screen buffer, raw mode, and diffed
 * repaints. Full-screen redraw every frame is what causes flicker over
 * herdr panes and SSH; this keeps the previous frame's rows and only
 * rewrites the ones that changed, batched into a single `write` so the
 * terminal never renders a half-updated frame.
 */

import { Canvas } from "./canvas.ts";
import { decodeKeys, type Key } from "./keys.ts";

export interface ScreenOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

const ENTER_SEQ = "\x1b[?1049h\x1b[?25l\x1b[H";
const LEAVE_SEQ = "\x1b[?25h\x1b[?1049l";

export class Screen {
  #stdout: NodeJS.WriteStream;
  #stdin: NodeJS.ReadStream;
  #open = false;
  #previousLines: string[] = [];
  #keyHandlers = new Set<(key: Key) => void>();
  #resizeHandlers = new Set<(columns: number, rows: number) => void>();
  #priorRawMode: boolean | null = null;
  #onData: ((chunk: string) => void) | null = null;
  #onResize: (() => void) | null = null;
  #exitHandlers: Array<() => void> = [];

  constructor(options: ScreenOptions = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#stdin = options.stdin ?? process.stdin;
  }

  get columns(): number {
    return this.#stdout.columns ?? 80;
  }

  get rows(): number {
    return this.#stdout.rows ?? 24;
  }

  get open(): boolean {
    return this.#open;
  }

  enter(): void {
    if (this.#open) return;
    this.#open = true;
    this.#stdout.write(ENTER_SEQ);

    this.#priorRawMode = this.#stdin.isRaw ?? null;
    if (this.#stdin.setRawMode) this.#stdin.setRawMode(true);
    this.#stdin.resume();
    this.#stdin.setEncoding("utf8");

    this.#onData = (chunk: string) => {
      for (const key of decodeKeys(chunk)) {
        for (const handler of this.#keyHandlers) handler(key);
      }
    };
    this.#stdin.on("data", this.#onData);

    this.#onResize = () => {
      this.invalidate();
      for (const handler of this.#resizeHandlers) handler(this.columns, this.rows);
    };
    this.#stdout.on("resize", this.#onResize);

    const leaveOnSignal = () => this.leave();
    process.on("exit", leaveOnSignal);
    process.on("SIGINT", leaveOnSignal);
    process.on("SIGTERM", leaveOnSignal);
    process.on("SIGHUP", leaveOnSignal);
    const proc: NodeJS.EventEmitter = process;
    this.#exitHandlers = [
      () => proc.removeListener("exit", leaveOnSignal),
      () => proc.removeListener("SIGINT", leaveOnSignal),
      () => proc.removeListener("SIGTERM", leaveOnSignal),
      () => proc.removeListener("SIGHUP", leaveOnSignal),
    ];
  }

  leave(): void {
    if (!this.#open) return;
    this.#open = false;

    this.#stdout.write(LEAVE_SEQ);
    if (this.#stdin.setRawMode && this.#priorRawMode !== null) {
      this.#stdin.setRawMode(this.#priorRawMode);
    }
    this.#stdin.pause();

    if (this.#onData) this.#stdin.removeListener("data", this.#onData);
    this.#onData = null;
    if (this.#onResize) this.#stdout.removeListener("resize", this.#onResize);
    this.#onResize = null;

    for (const remove of this.#exitHandlers) remove();
    this.#exitHandlers = [];

    this.#previousLines = [];
  }

  render(canvas: Canvas): void {
    const lines = canvas.toLines();
    let out = "";
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row] ?? "";
      if (this.#previousLines[row] === line) continue;
      out += `\x1b[${row + 1};1H\x1b[2K${line}`;
    }
    if (out.length > 0) {
      out += `\x1b[${lines.length};1H`;
      this.#stdout.write(out);
    }
    this.#previousLines = lines;
  }

  invalidate(): void {
    this.#previousLines = [];
  }

  onKey(handler: (key: Key) => void): () => void {
    this.#keyHandlers.add(handler);
    return () => this.#keyHandlers.delete(handler);
  }

  onResize(handler: (columns: number, rows: number) => void): () => void {
    this.#resizeHandlers.add(handler);
    return () => this.#resizeHandlers.delete(handler);
  }

  setTitle(title: string): void {
    this.#stdout.write(`\x1b]0;${title}\x07`);
  }

  bell(): void {
    this.#stdout.write("\x07");
  }
}
