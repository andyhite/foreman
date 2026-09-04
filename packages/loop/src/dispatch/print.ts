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
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import type {
  DispatchHandle,
  DispatchOutcome,
  Dispatcher,
  DispatchRequest,
  DispatchStatus,
  GlobalConfig,
} from "@foreman/core";
import { ensureWorktree } from "@foreman/core";

/** Total stdout+stderr retained per dispatch; beyond this, older bytes are dropped, keeping the tail. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

interface RunningProcess {
  handles: DispatchHandle[];
  outcome: Promise<DispatchOutcome>;
  settled: boolean;
  status: DispatchStatus;
  child: ChildProcess;
}

/** Signals a spawned child's whole process group (it is started `detached: true`), falling back to the bare pid if the group is already gone. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // The group (or the process) is already gone.
  }
}

export class PrintDispatcher implements Dispatcher {
  readonly kind = "print" as const;

  readonly #config: GlobalConfig;
  readonly #scrubEnv: readonly string[];
  readonly #running = new Map<string, RunningProcess>();
  readonly #keyByDispatchId = new Map<string, string>();

  constructor(config: GlobalConfig, options?: { scrubEnv?: string[] }) {
    this.#config = config;
    this.#scrubEnv = options?.scrubEnv ?? [];
  }

  async dispatch(request: DispatchRequest): Promise<DispatchHandle[]> {
    const key = request.items[0]?.dispatchId ?? randomUUID();
    const startedAt = new Date().toISOString();
    const handles: DispatchHandle[] = request.items.map((item) => ({
      dispatchId: item.dispatchId,
      agent: request.agent,
      issueId: item.issueId,
      startedAt,
      pid: null,
      herdr: null,
    }));

    const { promise: outcomeReady, resolve: resolveOutcome } =
      Promise.withResolvers<DispatchOutcome>();

    const worktreeItems = request.items.filter((item) => item.worktree);
    if (worktreeItems.length > 0 && request.items.length > 1) {
      throw new Error("print dispatch cannot mix a worktree item with other items in one request");
    }
    const worktree = request.items.length === 1 ? request.items[0]?.worktree : undefined;
    const cwd = worktree?.path ?? request.cwd;
    if (worktree) {
      // Print mode has no herdr `worktree create` step, and the task guard's
      // own `ensureWorktree` call runs inside the dispatched session, after
      // spawn — so the worktree must exist before we spawn into it.
      // Idempotent: a resumed attempt against an already-registered worktree
      // returns `created: false` rather than failing.
      await ensureWorktree({
        repoPath: request.cwd,
        worktreePath: worktree.path,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
      });
    }

    const subjects = request.items
      .map((item) => item.subject)
      .filter((subject): subject is string => subject !== null);
    const prompt = [request.command, ...subjects].join(" ");

    const argv = [
      "-p",
      "--approval-mode",
      this.#config.agent.approvalMode,
      "--cwd",
      cwd,
      prompt,
    ];

    // FOREMAN-SEC-001: the loop's own Linear credential (e.g. LINEAR_API_KEY)
    // must not be handed to a prompt-injectable workflow agent's environment
    // verbatim, so it stays out of that process's `ps`/`env` surface and out
    // of anything it spawns. This is not containment: `linear.apiKeyFile` is
    // required for loop dispatch precisely so the dispatched session's own
    // extension can read the credential from disk, and every agent in that
    // session holds a `read` tool that can read it too. Callers pass the
    // configured credential env var name(s) as `scrubEnv`.
    const env = { ...process.env };
    for (const name of this.#scrubEnv) {
      delete env[name];
    }
    if (request.items.length === 1) {
      env.FOREMAN_DISPATCH_ID = handles[0]?.dispatchId;
    }

    const child = spawn(this.#config.agent.ompBin, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: true,
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
    let hardKillTimer: NodeJS.Timeout | undefined;
    const killTimer =
      maxRuntimeMs > 0
        ? setTimeout(() => {
            killGroup(child, "SIGTERM");
            hardKillTimer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
          }, maxRuntimeMs)
        : undefined;

    const entry: RunningProcess = {
      handles,
      status: "starting",
      settled: false,
      outcome: outcomeReady,
      child,
    };
    this.#running.set(key, entry);
    for (const item of request.items) this.#keyByDispatchId.set(item.dispatchId, key);

    child.on("spawn", () => {
      entry.status = "running";
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      clearTimeout(hardKillTimer);
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
      clearTimeout(hardKillTimer);
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

  // A dispatch absent from `#running` is overwhelmingly a dispatch whose
  // `settle()` already pruned the entry, not a lost dispatch — defaulting to
  // "settled" here is deliberate, not a fallback for a bug.
  async status(handle: DispatchHandle): Promise<DispatchStatus> {
    const key = this.#keyByDispatchId.get(handle.dispatchId);
    const entry = key ? this.#running.get(key) : undefined;
    if (entry) return entry.status;
    // A handle from a previous process is not tracked here, but its child may
    // still be alive — the same property `FallbackDispatcher.#ownerOf` preserves
    // for herdr handles.
    if (handle.pid !== null && handle.pid !== undefined) {
      try {
        process.kill(handle.pid, 0);
        return "running";
      } catch {
        return "settled";
      }
    }
    return "settled";
  }

  /** Awaits and prunes the tracked entry once the dispatch's outcome resolves. */
  async settle(handle: DispatchHandle): Promise<DispatchOutcome> {
    const key = this.#keyByDispatchId.get(handle.dispatchId);
    const entry = key ? this.#running.get(key) : undefined;
    if (!entry || !key) {
      // Never tracked (e.g. a handle from another process, or a sibling
      // handle whose entry a prior settle() already pruned); nothing to
      // report.
      return { handle, status: "settled", exitCode: null, log: "" };
    }
    const outcome = await entry.outcome;
    this.#running.delete(key);
    for (const item of entry.handles) this.#keyByDispatchId.delete(item.dispatchId);
    return { ...outcome, handle };
  }

  /** Best-effort SIGTERM of a live dispatch's process group; the existing `maxRuntimeMs` timer is the SIGKILL backstop, so this never escalates itself. */
  async abort(handle: DispatchHandle): Promise<void> {
    const key = this.#keyByDispatchId.get(handle.dispatchId);
    const entry = key ? this.#running.get(key) : undefined;
    if (!entry || entry.settled) return;
    killGroup(entry.child, "SIGTERM");
  }

  async available(): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile(this.#config.agent.ompBin, ["--version"], { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
    return promise;
  }

}
