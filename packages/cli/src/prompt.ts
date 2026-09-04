/**
 * Terminal prompts for `foreman setup` and `foreman init`.
 *
 * Hand-rolled, same rationale as the loop CLIs' argument parsers: the
 * workspace's sole runtime dependency is `@sinclair/typebox`, so no prompt
 * library here. `Prompter` is the seam — `NonInteractivePrompter` answers
 * every question with its default so `--yes` and piped/CI stdin behave the
 * same way instead of hanging on a read from a closed stream.
 */

import * as readline from "node:readline";
import { style } from "./tui.ts";

export interface Choice<T extends string> {
  value: T;
  label: string;
}
export interface Prompter {
  text(question: string, defaultValue: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(question: string, choices: Array<Choice<T>>, defaultValue: T): Promise<T>;
  /** Never echoes input. Non-interactive implementations must return "". */
  secret(question: string): Promise<string>;
  close(): void;
}

/** Prompts on a real terminal: default hints in `[brackets]`, secrets masked with `*`. */
export class InteractivePrompter implements Prompter {
  private readonly rl: readline.Interface;
  private readonly log: (message: string) => void;

  constructor(options?: { log?: (message: string) => void }) {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.log = options?.log ?? ((message: string) => console.log(message));
    // With no listener, readline's own SIGINT default just closes the
    // interface — `rl.question`'s callback never fires, so `text`/`confirm`/
    // `select` (which all go through `this.ask`) leave the process to fall
    // off the event loop with exit code 0 instead of the Ctrl-C convention
    // `secret` already honors. Attaching a listener here makes
    // readline emit "SIGINT" instead of self-closing, for every prompt alike.
    this.rl.on("SIGINT", () => {
      this.rl.close();
      process.stdout.write("\n");
      process.exit(130);
    });
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
   * Fix: detach that listener for the duration of the prompt and drive
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
    let escapeState: "none" | "esc" | "csi" = "none";
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
          if (escapeState === "csi") {
            // Consuming a CSI body: parameter/intermediate bytes continue
            // it, a byte in `@`-`~` is the final byte that ends it. An arrow
            // key's direction, a focus-report's `I`/`O`, a mouse event's
            // coordinates — none of it is typed text. Swallow it whole so a
            // stray escape sequence never corrupts the masked secret.
            if (ch >= "@" && ch <= "~") escapeState = "none";
            continue;
          }
          if (escapeState === "esc") {
            escapeState = ch === "[" || ch === "O" ? "csi" : "none";
            continue;
          }
          if (ch === "\x1b") {
            escapeState = "esc";
          } else if (ch === "\x03") {
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

  close(): void {
    // No terminal resource to release.
  }
}
