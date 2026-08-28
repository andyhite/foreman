/**
 * Alternate-screen terminal control for the board TUI (SPEC §17.4). Zero
 * dependencies: raw ANSI escapes and `process.stdin`/`process.stdout` only.
 *
 * A TUI that leaves the terminal in raw mode or on the alternate screen after
 * a crash is worse than no TUI — every exit path (`stop()`, SIGINT, SIGTERM,
 * an uncaught exception) must restore the terminal exactly once.
 */

import type { EventEmitter } from "node:events";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface Terminal {
  size(): TerminalSize;
  /** Compose and write a whole frame in one syscall — never partial writes mid-frame. */
  writeFrame(frame: string): void;
  onResize(listener: (size: TerminalSize) => void): void;
  onKey(listener: (chunk: Uint8Array) => void): void;
  /** Restores the terminal. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens the alternate screen, hides the cursor, and puts stdin into raw mode.
 * Registers restoration on `stop()`, SIGINT, SIGTERM, and `uncaughtException`
 * so no exit path leaves the terminal broken.
 */
export function openTerminal(): Terminal {
  const stdout = process.stdout;
  const processEvents = process as unknown as EventEmitter;
  const stdin = process.stdin;
  let stopped = false;
  const resizeListeners: Array<(size: TerminalSize) => void> = [];
  const keyListeners: Array<(chunk: Uint8Array) => void> = [];

  stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + CLEAR_SCREEN);

  const wasRaw = stdin.isRaw ?? false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const onData = (chunk: Buffer) => {
    for (const listener of keyListeners) listener(chunk);
  };
  stdin.on("data", onData);

  const onResize = () => {
    const size = { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
    for (const listener of resizeListeners) listener(size);
  };
  stdout.on("resize", onResize);

  const restore = () => {
    if (stopped) return;
    stopped = true;
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  };

  const onSignal = () => {
    restore();
    process.exit(130);
  };
  const onUncaught = (error: unknown) => {
    restore();
    // biome-ignore lint: terminal state must be restored before the crash reaches the console.
    console.error(error);
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onUncaught);
  process.on("exit", restore);

  return {
    size(): TerminalSize {
      return { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
    },
    writeFrame(frame: string): void {
      if (stopped) return;
      stdout.write(CLEAR_SCREEN + frame);
    },
    onResize(listener: (size: TerminalSize) => void): void {
      resizeListeners.push(listener);
    },
    onKey(listener: (chunk: Uint8Array) => void): void {
      keyListeners.push(listener);
    },
    stop(): void {
      restore();
      processEvents.off("SIGINT", onSignal);
      processEvents.off("SIGTERM", onSignal);
      processEvents.off("uncaughtException", onUncaught);
      processEvents.off("exit", restore);
    },
  };
}
