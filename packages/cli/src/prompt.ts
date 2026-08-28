/**
 * Terminal prompts for `foreman setup`.
 *
 * Hand-rolled, same rationale as `foreman-loop`'s argument parser: the
 * workspace's sole runtime dependency is `@sinclair/typebox`, so no prompt
 * library here. `Prompter` is the seam — `NonInteractivePrompter` answers
 * every question with its default so `--yes` and piped/CI stdin behave the
 * same way instead of hanging on a read from a closed stream.
 */

import * as readline from "node:readline";

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

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  private ask(question: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    this.rl.question(question, resolve);
    return promise;
  }

  async text(question: string, defaultValue: string): Promise<string> {
    const hint = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.ask(`${question}${hint}: `)).trim();
    return answer.length > 0 ? answer : defaultValue;
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await this.ask(`${question} [${hint}]: `)).trim().toLowerCase();
    if (answer.length === 0) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  async select<T extends string>(question: string, choices: Array<Choice<T>>, defaultValue: T): Promise<T> {
    console.log(question);
    choices.forEach((choice, index) => {
      const marker = choice.value === defaultValue ? "*" : " ";
      console.log(`  ${marker} ${index + 1}) ${choice.label}`);
    });
    const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue) + 1;
    const answer = (await this.ask(`Choice [${defaultIndex}]: `)).trim();
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
    this.rl.question(question, (answer) => {
      if (originalWrite) rlInternal._writeToOutput = originalWrite;
      resolve(answer.trim());
    });
    masking = true;
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
