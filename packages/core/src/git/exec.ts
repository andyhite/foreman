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
    options: { cwd: string; env?: Record<string, string> },
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
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
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
