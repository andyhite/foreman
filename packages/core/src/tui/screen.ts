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

/**
 * Index within `text` where a trailing, still-arriving escape sequence
 * begins, or `text.length` when nothing is held back. Chunk boundaries land
 * mid-sequence routinely over SSH and inside multiplexer panes; decoding a
 * truncated CSI/SS3 introducer immediately corrupts it into stray literal
 * characters, so the incomplete tail is buffered instead and retried once
 * the rest arrives (or flushed after a short timeout).
 */
function trailingPartialEscapeIndex(text: string): number {
  const idx = text.lastIndexOf("\x1b");
  if (idx === -1) return text.length;
  const tail = text.slice(idx);
  if (tail.startsWith("\x1b[200~") && !tail.includes("\x1b[201~")) return idx;
  if (/^\x1b\[[0-9;]*[A-Za-z~]/.test(tail)) return text.length;
  if (/^\x1bO[A-Za-z]/.test(tail)) return text.length;
  if (tail.length >= 2 && tail[1] !== "[" && tail[1] !== "O") return text.length;
  return idx;
}

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
  #pendingInput = "";
  #pendingTimer: ReturnType<typeof setTimeout> | null = null;

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
      const combined = this.#pendingInput + chunk;
      const cut = trailingPartialEscapeIndex(combined);
      const ready = combined.slice(0, cut);
      const partial = combined.slice(cut);
      this.#pendingInput = partial;
      if (this.#pendingTimer) {
        clearTimeout(this.#pendingTimer);
        this.#pendingTimer = null;
      }
      if (partial) {
        // A split arriving mid-multiplexer-hop may never send its
        // continuation; flush the held bytes as-is after a short grace
        // period rather than losing a lone ESC or arrow key forever.
        this.#pendingTimer = setTimeout(() => {
          const flush = this.#pendingInput;
          this.#pendingInput = "";
          this.#pendingTimer = null;
          for (const key of decodeKeys(flush)) {
            for (const handler of this.#keyHandlers) handler(key);
          }
        }, 50);
      }
      for (const key of decodeKeys(ready)) {
        for (const handler of this.#keyHandlers) handler(key);
      }
    };
    this.#stdin.on("data", this.#onData);

    this.#onResize = () => {
      this.invalidate();
      for (const handler of this.#resizeHandlers) handler(this.columns, this.rows);
    };
    this.#stdout.on("resize", this.#onResize);

    const leaveOnSignal = (signal: NodeJS.Signals) => {
      this.leave();
      // Registering a listener suppresses Node/Bun's default terminate
      // action, so the process must re-raise its own exit; SIGHUP has no
      // conventional exit code, this mirrors the shell convention of
      // 128 + signal number for INT (2), TERM (15), HUP (1).
      const signo = signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1;
      process.exit(128 + signo);
    };
    const exitHandler = () => this.leave();
    process.on("exit", exitHandler);
    process.on("SIGINT", leaveOnSignal);
    process.on("SIGTERM", leaveOnSignal);
    process.on("SIGHUP", leaveOnSignal);
    const proc: NodeJS.EventEmitter = process;
    this.#exitHandlers = [
      () => proc.removeListener("exit", exitHandler),
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

    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }
    this.#pendingInput = "";

    for (const remove of this.#exitHandlers) remove();
    this.#exitHandlers = [];

    this.#previousLines = [];
  }


  render(canvas: Canvas): void {
    if (!this.#open) return;
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
