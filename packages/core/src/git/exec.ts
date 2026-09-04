/**
 * Process-execution seam for everything under `git/` and `github/`.
 *
 * All Foreman-managed subprocess calls go through `argv`, never a shell
 * string — a branch name or Linear title becomes a `git`/`gh` argument
 * verbatim, and shell interpolation is exactly how that turns into command
 * injection. Tests substitute a stub `CommandRunner`; production uses
 * `nodeRunner`.
 */

import { execFile } from "node:child_process";

export interface CommandRunner {
  run(
    argv: string[],
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Thrown by `nodeRunner` when a command exits non-zero. */
export class CommandFailed extends Error {
  readonly argv: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(argv: string[], code: number, stderr: string) {
    super(`command failed (${code}): ${argv.join(" ")}\n${stderr}`);
    this.name = "CommandFailed";
    this.argv = argv;
    this.code = code;
    this.stderr = stderr;
  }
}

export const nodeRunner: CommandRunner = {
  run(argv, options) {
    const [command, ...args] = argv;
    if (!command) {
      return Promise.reject(new CommandFailed(argv, -1, "empty argv"));
    }
    const { promise, resolve, reject } = Promise.withResolvers<{
      stdout: string;
      stderr: string;
      code: number;
    }>();
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        // `git`/`gh` reach the network (fetch, pr list) from inside the loop's
        // singleton tick; an HTTPS remote with no cached credential would
        // otherwise block forever under piped stdio, freezing the whole loop
        // (LinearClient bounds its own requests with a 30s AbortSignal.timeout
        // for the same reason). `GIT_TERMINAL_PROMPT`/`GIT_ASKPASS` suppress
        // the interactive credential prompt that timeout alone would just
        // make slower to hit.
        env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          // Spawn failure (e.g. binary not found) rather than a non-zero exit.
          reject(new CommandFailed(argv, -1, error.message));
          return;
        }
        const code = error ? ((error.code as number | undefined) ?? 1) : 0;
        if (code !== 0) {
          reject(new CommandFailed(argv, code, stderr));
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
    return promise;
  },
};
