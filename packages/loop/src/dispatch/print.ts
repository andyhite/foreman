/**
 * `PrintDispatcher` (SPEC §17.2).
 *
 * `omp -p '<command>'` — headless, no dependencies, zero visibility while
 * running. The approval-mode flag is passed explicitly rather than left at
 * defaults: the print-mode parent session is a second interrupt surface
 * (§17.3) and stalls headless on its own tool calls if it is ever allowed to
 * ask.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
} from "@foreman/core";
import { reservationsPath, RESERVATIONS_ENV } from "@foreman/core";

/** Total stdout+stderr retained per dispatch; beyond this, older bytes are dropped, keeping the tail. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

interface RunningProcess {
  handles: DispatchHandle[];
  outcome: Promise<DispatchOutcome>;
  settled: boolean;
  status: DispatchStatus;
}

export class PrintDispatcher implements Dispatcher {
  readonly kind = "print" as const;

  readonly #config: GlobalConfig;
  readonly #scrubEnv: readonly string[];
  readonly #reservationsDir: string | undefined;
  readonly #running = new Map<string, RunningProcess>();

  constructor(config: GlobalConfig, options?: { scrubEnv?: string[]; reservationsDir?: string }) {
    this.#config = config;
    this.#scrubEnv = options?.scrubEnv ?? [];
    this.#reservationsDir = options?.reservationsDir;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const batchId = randomUUID();
    const startedAt = new Date().toISOString();
    const handles: DispatchHandle[] = request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt,
      batchId,
      pid: null,
      herdr: null,
    }));

    const { promise: outcomeReady, resolve: resolveOutcome } =
      Promise.withResolvers<DispatchOutcome>();

    const subjects = request.items
      .map((item) => item.subject)
      .filter((subject): subject is string => subject !== null);
    const prompt = [request.command, ...subjects].join(" ");

    const argv = [
      "-p",
      "--approval-mode",
      this.#config.agent.approvalMode,
      "--cwd",
      request.cwd,
      prompt,
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
    // Only a single-item request gets the legacy per-item id: a batch has no
    // one dispatch id to hand the child, and its items resolve theirs from
    // the reservations file instead (see below).
    if (request.items.length === 1) {
      env.FOREMAN_DISPATCH_ID = handles[0]?.dispatchId;
    }
    if (this.#reservationsDir) {
      env[RESERVATIONS_ENV] = reservationsPath(this.#reservationsDir, request.agent);
    }

    const child = spawn(this.#config.agent.ompBin, argv, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    for (const handle of handles) {
      handle.pid = child.pid ?? null;
    }

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
      handles,
      status: "starting",
      settled: false,
      outcome: outcomeReady,
    };
    this.#running.set(batchId, entry);

    child.on("spawn", () => {
      entry.status = "running";
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      entry.status = "lost";
      entry.settled = true;
      // Retained (not deleted) until every handle in the batch has consumed
      // it via `settle()`: a caller that awaits `settle()` after the child
      // has already exited is the normal case for a short print-mode run,
      // not a race to lose.
      appendCapped(Buffer.from(`\n${String(error)}`));
      resolveOutcome({
        handle: handles[0] as DispatchHandle,
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
        handle: handles[0] as DispatchHandle,
        status: "settled",
        exitCode: code,
        log: Buffer.concat(logChunks, logSize).toString("utf8"),
      });
    });

    return handles;
  }

  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    const entry = this.#running.get(handle.batchId);
    return entry ? entry.status : "settled";
  }

  /** Awaits and prunes the tracked entry once the batch's outcome resolves. */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    const entry = this.#running.get(handle.batchId);
    if (!entry) {
      // Never tracked (e.g. a handle from another process, or a sibling
      // handle whose batch entry a prior settle() already pruned); nothing
      // to report.
      return { handle, status: "settled", exitCode: null, log: "" };
    }
    const outcome = await entry.outcome;
    this.#running.delete(handle.batchId);
    return { ...outcome, handle };
  }

  async available(): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile(this.#config.agent.ompBin, ["--version"], (error) => {
      resolve(!error);
    });
    return promise;
  }

}
