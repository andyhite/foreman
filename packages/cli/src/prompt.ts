/**
 * Terminal prompts for `foreman setup`.
 *
 * Hand-rolled, same rationale as `foreman-loop`'s argument parser: the
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
    this.log(`${style("cyan", "?")} ${style("bold", question)}`);
    choices.forEach((choice, index) => {
      const marker = choice.value === defaultValue ? style("green", "●") : style("dim", "○");
      this.log(`  ${marker} ${index + 1}) ${choice.label}`);
    });
    const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue) + 1;
    const answer = (await this.ask(`${style("dim", `Choice [${defaultIndex}]`)}: `)).trim();
    if (answer.length === 0) return defaultValue;
    const chosen = choices[Number.parseInt(answer, 10) - 1];
    return chosen ? chosen.value : defaultValue;
  }

  /** Masks input by intercepting the interface's own output writer while the answer is typed. */
  secret(question: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    const rlInternal = this.rl as unknown as {
      _writeToOutput?: (text: string) => void;
      output: NodeJS.WritableStream;
    };
    const originalWrite = rlInternal._writeToOutput?.bind(rlInternal);
    let masking = false;
    rlInternal._writeToOutput = (text: string) => {
      if (masking && text !== "\r\n" && text !== "\n") rlInternal.output.write("*".repeat(text.length));
      else originalWrite ? originalWrite(text) : rlInternal.output.write(text);
    };
    this.rl.question(`${style("cyan", "?")} ${question}`, (answer) => {
      if (originalWrite) rlInternal._writeToOutput = originalWrite;
      resolve(answer.trim());
    });
    masking = true;
    return promise;
  }

  /** Renders `lines` in place: `redraw` overwrites the previous frame instead of scrolling. */
  private redraw(lines: string[], previousLineCount: number): number {
    if (previousLineCount > 0) process.stdout.write(`\x1b[${previousLineCount}A\x1b[0J`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return lines.length;
  }

  async multiSelect<T extends string>(question: string, choices: Array<CheckboxChoice<T>>): Promise<T[]> {
    if (!process.stdin.isTTY || choices.length === 0) {
      return choices.filter((choice) => choice.checked).map((choice) => choice.value);
    }

    const checked = choices.map((choice) => choice.checked);
    let cursor = 0;
    let linesPrinted = 0;

    const frame = (): string[] => {
      const lines = [
        `${style("cyan", "?")} ${style("bold", question)}`,
        style("dim", "  ↑/↓ move   space toggle   a select all   enter confirm"),
      ];
      choices.forEach((choice, index) => {
        const box = checked[index] ? style("green", "[x]") : style("dim", "[ ]");
        const pointer = index === cursor ? style("cyan", "›") : " ";
        const label = index === cursor ? style("bold", choice.label) : choice.label;
        const hint = choice.hint ? style("dim", `  ${choice.hint}`) : "";
        lines.push(`  ${pointer} ${box} ${label}${hint}`);
      });
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
