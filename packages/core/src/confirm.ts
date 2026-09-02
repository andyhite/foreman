/**
 * Operator confirmation (SPEC §17.9).
 *
 * `loop.mode` has exactly two values. Under `yolo` the loop acts on its own
 * decisions; under `confirm` it asks first, and every action that changes
 * state *outside this process* — an agent dispatch, a Linear mutation — must
 * pass through `Confirmer.confirm` before it runs.
 *
 * The loop's own control-plane persistence (`status.json`, `bookkeeping.json`,
 * `loop.lock`) is deliberately not gated: those files are how the process
 * remembers what it already did, so prompting for them would make `confirm`
 * mode unable to keep books rather than more careful.
 *
 * `summary` is a sentence, not a serialized call. A generic proxy around
 * `LinearWriter` could gate the same writes with less code, but it could only
 * ever print `updateIssue ENG-142 stateId=6f2c…`; only the caller knows the
 * action means "move ENG-142 to Done". The operator is answering the sentence,
 * so the caller composes it.
 *
 * Blocking here is safe: `Supervisor.runTick` awaits its workers in sequence
 * and the cadence wait happens strictly between ticks, so a pending question
 * delays the next tick instead of racing one.
 */

import * as readline from "node:readline";

export interface ConfirmRequest {
  /**
   * Stable machine code, reused verbatim as the `SkipRecord` code when the
   * operator declines — `dispatch-declined` and `linear-write-declined` are
   * groupable in `/foreman:status`, "user said no" is not.
   */
  kind: string;
  /** One operator-facing line, imperative: `dispatch foreman-implement for ENG-142`. */
  summary: string;
  /** Extra lines printed indented under the summary: the command, the cwd, the transition. */
  detail?: readonly string[];
}

export interface Confirmer {
  /**
   * Whether the action may proceed. Never throws and never rejects: a closed
   * or unreadable stream denies, so the failure mode of a confirmation
   * channel that has gone away is a loop that stops acting, not one that acts
   * unasked.
   */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Releases the terminal, if this confirmer holds it. */
  close(): void;
}

/** `loop.mode: "yolo"` — every action proceeds, nothing is printed, nothing is read. */
export const YOLO_CONFIRMER: Confirmer = {
  confirm: () => Promise.resolve(true),
  close: () => {},
};

/**
 * Wraps any `Confirmer` so every request's summary/detail is logged before
 * delegating — `TtyConfirmer` already logs what it asks, so this exists for
 * `YOLO_CONFIRMER`: `--verbose` in yolo mode still wants to see what the
 * loop is doing under the hood, just without blocking for an answer.
 */
export function verboseConfirmer(inner: Confirmer, log: (message: string) => void): Confirmer {
  return {
    confirm: async (request) => {
      log(`confirm (auto): ${request.summary}`);
      for (const line of request.detail ?? []) log(`  ${line}`);
      return inner.confirm(request);
    },
    close: () => inner.close(),
  };
}

/** Denies every action without prompting. The `--once`/non-TTY guard rejects before this is reachable; it exists so tests can pin "declined" behavior without a terminal. */
export const DENY_CONFIRMER: Confirmer = {
  confirm: () => Promise.resolve(false),
  close: () => {},
};

export interface TtyConfirmerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Where the question itself goes. The loop's `log` also broadcasts to
   * control-plane subscribers, so `/foreman:status` shows what the loop is
   * waiting on rather than an unexplained stall.
   */
  log: (message: string) => void;
}

/**
 * `loop.mode: "confirm"` — asks on the loop's own terminal.
 *
 * One readline interface for the process, created on the first question and
 * reused: the loop asks many times over its lifetime, and tearing the
 * interface down between questions drops keystrokes typed during the gap.
 */
export class TtyConfirmer implements Confirmer {
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #log: (message: string) => void;
  #rl: readline.Interface | null = null;
  #closed = false;

  constructor(options: TtyConfirmerOptions) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#log = options.log;
  }

  #interface(): readline.Interface {
    if (!this.#rl) {
      this.#rl = readline.createInterface({ input: this.#input, output: this.#output });
    }
    return this.#rl;
  }

  async confirm(request: ConfirmRequest): Promise<boolean> {
    if (this.#closed) return false;
    this.#log(`confirm: ${request.summary}`);
    for (const line of request.detail ?? []) this.#log(`  ${line}`);

    const answer = await new Promise<string | null>((resolve) => {
      let settled = false;
      const rl = this.#interface();
      const onClose = (): void => finish(null);
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        rl.off("close", onClose);
        resolve(value);
      };
      rl.once("close", onClose);
      try {
        rl.question("Proceed? [y/N] ", (line) => finish(line));
      } catch {
        finish(null);
      }
    });

    if (answer === null) {
      this.#log("confirmation channel closed; declining");
      return false;
    }
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  }

  close(): void {
    this.#closed = true;
    this.#rl?.close();
    this.#rl = null;
  }
}
