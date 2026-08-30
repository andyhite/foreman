/**
 * `PrintDispatcher` (SPEC §17.2).
 *
 * `omp -p '<command>'` — headless, no dependencies, zero visibility while
 * running. The approval-mode flag is passed explicitly rather than left at
 * defaults: the print-mode parent session is a second interrupt surface
 * (§17.3) and stalls headless on its own tool calls if it is ever allowed to
 * ask.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import type { GlobalConfig } from "../config/schema.ts";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
} from "./types.ts";

/** Total stdout+stderr retained per dispatch; beyond this, older bytes are dropped, keeping the tail. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

interface RunningProcess {
  handle: DispatchHandle;
  outcome: Promise<DispatchOutcome>;
  settled: boolean;
  status: DispatchStatus;
}

export class PrintDispatcher implements Dispatcher {
  readonly kind = "print" as const;

  readonly #config: GlobalConfig;
  readonly #scrubEnv: readonly string[];
  readonly #running = new Map<string, RunningProcess>();

  constructor(config: GlobalConfig, options?: { scrubEnv?: string[] }) {
    this.#config = config;
    this.#scrubEnv = options?.scrubEnv ?? [];
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle> {
    const handle: DispatchHandle = {
      dispatchId: request.dispatchId,
      agent: request.agent,
      issueId: request.issueId,
      startedAt: new Date().toISOString(),
      pid: null,
      herdr: null,
    };

    const { promise: outcomeReady, resolve: resolveOutcome } =
      Promise.withResolvers<DispatchOutcome>();

    const argv = [
      "-p",
      "--approval-mode",
      this.#config.agent.approvalMode,
      "--cwd",
      request.cwd,
      request.command,
    ];

    // FOREMAN-SEC-001: an implement agent has bash and inherits this child's
    // environment, so a credential this loop resolved for its own Linear
    // calls (e.g. LINEAR_API_KEY) must not be handed to a prompt-injectable
    // workflow agent verbatim. Callers pass the configured credential env
    // var name(s) as `scrubEnv`.
    const env = { ...process.env };
    for (const name of this.#scrubEnv) {
      delete env[name];
    }
    env.FOREMAN_DISPATCH_ID = request.dispatchId;

    const child = spawn(this.#config.agent.ompBin, argv, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    handle.pid = child.pid ?? null;

    const logChunks: Buffer[] = [];
    let logSize = 0;
    const appendCapped = (chunk: Buffer): void => {
      logChunks.push(chunk);
      logSize += chunk.length;
      while (logSize > MAX_LOG_BYTES) {
        const first = logChunks[0];
        if (!first) break;
        const excess = logSize - MAX_LOG_BYTES;
        if (first.length <= excess) {
          logChunks.shift();
          logSize -= first.length;
        } else {
          logChunks[0] = first.subarray(excess);
          logSize -= excess;
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      appendCapped(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendCapped(chunk);
    });

    const maxRuntimeMs = this.#config.agent.maxRuntimeMs;
    const killTimer =
      maxRuntimeMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, maxRuntimeMs)
        : undefined;

    const entry: RunningProcess = {
      handle,
      status: "starting",
      settled: false,
      outcome: outcomeReady,
    };
    this.#running.set(handle.dispatchId, entry);

    child.on("spawn", () => {
      entry.status = "running";
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      entry.status = "lost";
      entry.settled = true;
      // Retained (not deleted) until `settle()` consumes and prunes it: a
      // caller that awaits `settle()` after the child has already exited is
      // the normal case for a short print-mode run, not a race to lose.
      appendCapped(Buffer.from(`\n${String(error)}`));
      resolveOutcome({
        handle,
        status: "lost",
        exitCode: null,
        log: Buffer.concat(logChunks, logSize).toString("utf8"),
      });
    });

    // `close` (not `exit`) fires once stdio is fully drained, so trailing
    // output written just before the process exits is not lost.
    child.on("close", (code) => {
      if (entry.settled) return;
      clearTimeout(killTimer);
      entry.status = "settled";
      entry.settled = true;
      resolveOutcome({
        handle,
        status: "settled",
        exitCode: code,
        log: Buffer.concat(logChunks, logSize).toString("utf8"),
      });
    });

    return handle;
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    const entry = this.#running.get(handle.dispatchId);
    return entry ? entry.status : "settled";
  }

  /** Awaits and prunes the tracked entry — the one place a settled outcome is released. */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    const entry = this.#running.get(handle.dispatchId);
    if (!entry) {
      // Never tracked (e.g. a handle from another process); nothing to report.
      return { handle, status: "settled", exitCode: null, log: "" };
    }
    const outcome = await entry.outcome;
    this.#running.delete(handle.dispatchId);
    return outcome;
  }

  async available(): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile(this.#config.agent.ompBin, ["--version"], (error) => {
      resolve(!error);
    });
    return promise;
  }

}
