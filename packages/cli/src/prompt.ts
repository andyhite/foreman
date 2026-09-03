/**
 * Terminal prompts for `foreman setup` and `foreman init`.
 *
 * Hand-rolled, same rationale as the loop CLIs' argument parsers: the
 * workspace's sole runtime dependency is `@sinclair/typebox`, so no prompt
 * library here. `Prompter` is the seam — `NonInteractivePrompter` answers
 * every question with its default so `--yes` and piped/CI stdin behave the
 * same way instead of hanging on a read from a closed stream.
 *
 * `multiSelect` is the one prompt that needs raw keypresses instead of
 * line input (arrow keys, space to toggle) — it borrows the readline
 * interface's own input stream but takes over `keypress` handling for the
 * duration of the prompt, restoring the interface's listeners and cooked
 * mode before returning so `text`/`confirm`/`select` keep working after it.
 */

import * as readline from "node:readline";
import { style } from "./tui.ts";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface CheckboxChoice<T extends string> extends Choice<T> {
  checked: boolean;
  /** Rendered dim after the label, e.g. "(already mapped)". */
  hint?: string;
}

export interface Prompter {
  text(question: string, defaultValue: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(question: string, choices: Array<Choice<T>>, defaultValue: T): Promise<T>;
  /** Never echoes input. Non-interactive implementations must return "". */
  secret(question: string): Promise<string>;
  /** Checkbox picker. Non-interactive implementations return every pre-checked value. */
  multiSelect<T extends string>(question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]>;
  close(): void;
}

type Keypress = { name?: string; ctrl?: boolean } | undefined;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function terminalSize(): { rows: number; columns: number } {
  return {
    rows: process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24,
    columns: process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80,
  };
}

function physicalLineCount(line: string, columns: number): number {
  const visible = stripAnsi(line);
  if (visible.length === 0) return 1;
  return Math.max(1, Math.ceil(visible.length / columns));
}

function truncateVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

/** Prompts on a real terminal: default hints in `[brackets]`, secrets masked with `*`. */
export class InteractivePrompter implements Prompter {
  private readonly rl: readline.Interface;
  private readonly log: (message: string) => void;

  constructor(options?: { log?: (message: string) => void }) {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.log = options?.log ?? ((message: string) => console.log(message));
  }

  private ask(question: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    this.rl.question(question, resolve);
    return promise;
  }

  async text(question: string, defaultValue: string): Promise<string> {
    const hint = defaultValue ? style("dim", ` [${defaultValue}]`) : "";
    const answer = (await this.ask(`${style("cyan", "?")} ${question}${hint}: `)).trim();
    return answer.length > 0 ? answer : defaultValue;
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await this.ask(`${style("cyan", "?")} ${question} ${style("dim", `[${hint}]`)}: `))
      .trim()
      .toLowerCase();
    if (answer.length === 0) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  async select<T extends string>(question: string, choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue) + 1;
    while (true) {
      this.log(`${style("cyan", "?")} ${style("bold", question)}`);
      choices.forEach((choice, index) => {
        const marker = choice.value === defaultValue ? style("green", "●") : style("dim", "○");
        this.log(`  ${marker} ${index + 1}) ${choice.label}`);
      });
      const answer = (await this.ask(`${style("dim", `Choice [${defaultIndex}]`)}: `)).trim();
      if (answer.length === 0) return defaultValue;
      const index = Number.parseInt(answer, 10);
      if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1]!.value;
      }
      this.log(
        style(
          "yellow",
          `  Invalid choice "${answer}"; enter a number from 1 to ${choices.length}, or press Enter for the default.`,
        ),
      );
    }
  }

  /**
   * Masks input while it's typed. Two problems, one fix: line-based
   * `rl.question` breaks on a multi-line paste (a PEM private key, say) —
   * readline resolves the question on the *first* embedded newline, and
   * every subsequent pasted line is left sitting in the TTY's input
   * buffer, surfacing later as commands typed at the shell once this
   * process exits. And `readline.Interface` keeps its own `keypress`
   * listener attached for the life of the interface, which echoes every
   * byte it sees (including stray focus-report escapes some terminals send
   * on an app switch) straight back to the terminal regardless of what
   * this method does — that's both the un-masked characters showing up
   * mid-paste and the prompt line vanishing on a tab switch.
   *
   * Fix: detach that listener for the duration of the prompt (`multiSelect`
   * already does the same for its own custom keypress loop) and drive
   * bytes off a private `data` listener instead. Bracketed paste mode
   * (`\x1b[?2004h`) asks the terminal to wrap a paste in
   * `\x1b[200~`/`\x1b[201~` markers rather than sending it as ordinary
   * keystrokes, so embedded newlines inside those markers are read as
   * literal content and only a real Enter keypress — never a pasted one —
   * ends the prompt. Every terminal Foreman targets (Ghostty, iTerm2,
   * Terminal.app, VS Code, most Linux terminals) honors it.
   *
   * Nothing is echoed per keystroke: a single fixed-width mask appears
   * once input starts, rather than growing with (and so revealing) the
   * secret's length.
   */
  secret(question: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped stdin: no keypresses to intercept, so the plain line-based path is safe.
      this.rl.question(`${style("cyan", "?")} ${question}`, (answer) => resolve(answer.trim()));
      return promise;
    }

    process.stdout.write(`${style("cyan", "?")} ${question}`);
    const wasRaw = stdin.isRaw ?? false;
    const savedListeners = [...stdin.listeners("keypress")] as Array<(...args: unknown[]) => void>;
    for (const listener of savedListeners) stdin.removeListener("keypress", listener);
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?2004h");

    const MASK = "****";
    let buffer = "";
    let inPaste = false;
    let masked = false;

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      process.stdout.write("\x1b[?2004l");
      stdin.setRawMode(wasRaw);
      for (const listener of savedListeners) stdin.on("keypress", listener);
    };
    const finish = (): void => {
      cleanup();
      process.stdout.write("\n");
      resolve(buffer.trim());
    };
    const reveal = (): void => {
      if (masked) return;
      masked = true;
      process.stdout.write(style("dim", MASK));
    };

    const onData = (chunk: Buffer): void => {
      let text = chunk.toString("utf8");
      while (text.length > 0) {
        if (inPaste) {
          const end = text.indexOf("\x1b[201~");
          const literal = end === -1 ? text : text.slice(0, end);
          buffer += literal;
          if (literal.length > 0) reveal();
          if (end === -1) return;
          text = text.slice(end + 6);
          inPaste = false;
          continue;
        }
        const start = text.indexOf("\x1b[200~");
        const chars = start === -1 ? text : text.slice(0, start);
        for (const ch of chars) {
          if (ch === "\x03") {
            cleanup();
            process.stdout.write("\n");
            process.exit(130);
          } else if (ch === "\r" || ch === "\n") {
            finish();
            return;
          } else if (ch === "\x7f" || ch === "\b") {
            if (buffer.length > 0) buffer = buffer.slice(0, -1);
          } else if (ch >= " ") {
            buffer += ch;
            reveal();
          }
        }
        if (start === -1) {
          text = "";
        } else {
          text = text.slice(start + 6);
          inPaste = true;
        }
      }
    };
    stdin.on("data", onData);
    return promise;
  }

  /** Renders `lines` in place: `redraw` overwrites the previous frame instead of scrolling. */
  private redraw(lines: string[], previousPhysicalRows: number): number {
    const { columns } = terminalSize();
    if (previousPhysicalRows > 0) process.stdout.write(`\x1b[${previousPhysicalRows}A\x1b[0J`);
    let physicalRows = 0;
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
      physicalRows += physicalLineCount(line, columns);
    }
    return physicalRows;
  }

  async multiSelect<T extends string>(question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    if (!process.stdin.isTTY || choices.length === 0) {
      return choices.filter((choice) => choice.checked).map((choice) => choice.value);
    }

    const checked = choices.map((choice) => choice.checked);
    let cursor = 0;
    let scrollTop = 0;
    let linesPrinted = 0;

    const frame = (): string[] => {
      const { rows, columns } = terminalSize();
      const headerLines = 2;
      const scrollHintReserve = 2;
      const maxVisible = Math.max(1, rows - headerLines - scrollHintReserve);
      if (cursor < scrollTop) scrollTop = cursor;
      if (cursor >= scrollTop + maxVisible) scrollTop = cursor - maxVisible + 1;

      const lines = [
        `${style("cyan", "?")} ${style("bold", question)}`,
        style("dim", "  ↑/↓ move   space toggle   a select all   enter confirm"),
      ];
      if (scrollTop > 0) {
        lines.push(style("dim", `  ↑ ${scrollTop} more`));
      }

      const visibleEnd = Math.min(choices.length, scrollTop + maxVisible);
      for (let index = scrollTop; index < visibleEnd; index += 1) {
        const choice = choices[index]!;
        const box = checked[index] ? style("green", "[x]") : style("dim", "[ ]");
        const pointer = index === cursor ? style("cyan", "›") : " ";
        const plainLabel = truncateVisible(choice.label, Math.max(1, columns - 8));
        const label = index === cursor ? style("bold", plainLabel) : plainLabel;
        const hint = choice.hint ? style("dim", `  ${choice.hint}`) : "";
        lines.push(`  ${pointer} ${box} ${label}${hint}`);
      }

      const below = choices.length - visibleEnd;
      if (below > 0) {
        lines.push(style("dim", `  ↓ ${below} more`));
      }
      return lines;
    };

    linesPrinted = this.redraw(frame(), 0);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    const savedListeners = [...stdin.listeners("keypress")] as Array<(...args: unknown[]) => void>;
    for (const listener of savedListeners) stdin.removeListener("keypress", listener);
    readline.emitKeypressEvents(stdin, this.rl);
    stdin.setRawMode(true);
    stdin.resume();

    const { promise, resolve } = Promise.withResolvers<T[]>();
    const cleanup = (): void => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      for (const listener of savedListeners) stdin.on("keypress", listener);
    };
    const onKeypress = (_chunk: string, key: Keypress): void => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      switch (key?.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + choices.length) % choices.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % choices.length;
          break;
        case "space":
          checked[cursor] = !checked[cursor];
          break;
        case "a": {
          const nextValue = !checked.every(Boolean);
          for (let index = 0; index < checked.length; index += 1) checked[index] = nextValue;
          break;
        }
        case "return":
          cleanup();
          resolve(choices.filter((_, index) => checked[index]).map((choice) => choice.value));
          return;
        default:
          break;
      }
      linesPrinted = this.redraw(frame(), linesPrinted);
    };
    stdin.on("keypress", onKeypress);

    return promise;
  }

  close(): void {
    this.rl.close();
  }
}

/** Answers every question with its default. Used for `--yes` and non-TTY stdin. */
export class NonInteractivePrompter implements Prompter {
  text(_question: string, defaultValue: string): Promise<string> {
    return Promise.resolve(defaultValue);
  }

  confirm(_question: string, defaultValue: boolean): Promise<boolean> {
    return Promise.resolve(defaultValue);
  }

  select<T extends string>(_question: string, _choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    return Promise.resolve(defaultValue);
  }

  secret(_question: string): Promise<string> {
    return Promise.resolve("");
  }

  multiSelect<T extends string>(_question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    return Promise.resolve(choices.filter((choice) => choice.checked).map((choice) => choice.value));
  }

  close(): void {
    // No terminal resource to release.
  }
}
