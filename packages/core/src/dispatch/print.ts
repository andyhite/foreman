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

interface RunningProcess {
  handle: DispatchHandle;
  outcome: Promise<DispatchOutcome>;
  settled: boolean;
  status: DispatchStatus;
}

export class PrintDispatcher implements Dispatcher {
  readonly kind = "print" as const;

  readonly #config: GlobalConfig;
  readonly #running = new Map<string, RunningProcess>();

  constructor(config: GlobalConfig) {
    this.#config = config;
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

    const child = spawn(this.#config.agent.ompBin, argv, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    handle.pid = child.pid ?? null;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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
      this.#running.delete(handle.dispatchId);
      resolveOutcome({
        handle,
        status: "lost",
        exitCode: null,
        log: `${stdout}${stderr}\n${String(error)}`,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      entry.status = "settled";
      entry.settled = true;
      this.#running.delete(handle.dispatchId);
      resolveOutcome({
        handle,
        status: "settled",
        exitCode: code,
        log: `${stdout}${stderr}`,
      });
    });

    return handle;
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    const entry = this.#running.get(handle.dispatchId);
    return entry ? entry.status : "settled";
  }

  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    const entry = this.#running.get(handle.dispatchId);
    if (!entry) {
      // Already settled (or never tracked, e.g. a handle from another process);
      // nothing more can be reported.
      return { handle, status: "settled", exitCode: null, log: "" };
    }
    return entry.outcome;
  }

  async available(): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile(this.#config.agent.ompBin, ["--version"], (error) => {
      resolve(!error);
    });
    return promise;
  }
}
