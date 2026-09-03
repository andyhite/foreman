/**
 * Subprocess seam for `foreman setup`.
 *
 * Distinct from `@foreman/core`'s `nodeRunner`: that one captures output for
 * programmatic parsing (git/gh plumbing). Setup runs interactive, long-lived
 * commands the operator needs to watch — `bun install`, `omp plugin install` —
 * so this inherits stdio instead of buffering it.
 */

import { execFile, spawn } from "node:child_process";

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** Streams the child's stdio to the operator's terminal; resolves with its exit code. */
  run(bin: string, argv: string[], options?: { cwd?: string }): Promise<number>;
  /** Captures stdout/stderr for short probes (e.g. `omp plugin marketplace list`). */
  capture(bin: string, argv: string[], options?: { cwd?: string }): Promise<CaptureResult>;
  /** True when `bin` is on PATH and runnable. */
  exists(bin: string): Promise<boolean>;
}

export const processRunner: Runner = {
  run(bin, argv, options) {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const child = spawn(bin, argv, { cwd: options?.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    return promise;
  },

  capture(bin, argv, options) {
    const { promise, resolve, reject } = Promise.withResolvers<CaptureResult>();
    const child = spawn(bin, argv, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    // `close` (not `exit`) fires once stdio is fully drained, so trailing
    // output written just before the process exits is not lost.
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    return promise;
  },

  exists(bin) {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile(bin, ["--version"], { timeout: 5_000 }, (error) => {
      resolve(!(error && (error as NodeJS.ErrnoException).code === "ENOENT"));
    });
    return promise;
  },
};

/**
 * Best-effort "open this in the operator's browser". `foreman init`'s GitHub
 * App install check is the one place a next step can't be done from the CLI
 * at all — installing an App only ever happens on GitHub's own web UI — so
 * this saves the click rather than just printing a URL to copy. Fire and
 * forget: a headless/CI box with no browser to open is not an error, the
 * printed URL the caller already logs still covers it, so failures here are
 * swallowed rather than surfaced.
 */
export function openUrl(url: string): void {
  const platform = process.platform;
  const [bin, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser to open here — the caller's printed URL is the fallback.
  }
}
