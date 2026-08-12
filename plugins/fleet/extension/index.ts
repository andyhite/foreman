import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Minimal local shapes for what this extension actually touches on the
 * `ExtensionContext` passed to handlers/tools. `@oh-my-pi/pi-coding-agent`
 * is not an installed dependency of this plugin (it is provided by the omp
 * runtime that loads and executes this module), so the real `ExtensionAPI`/
 * `ExtensionContext` types are not resolvable here. `import type` above is
 * erased before execution and never attempts module resolution at runtime,
 * so it is safe to keep for documentation/IDE purposes; everything this
 * file actually relies on for type-checking is declared below instead.
 */
interface FleetExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

interface FleetToolCtx {
  cwd: string;
  // Managed timer handles — see `omp://extensions.md` "Background work". Used
  // by `ensureJoinPoller` below; isolated from the callback's own throws and
  // auto-cleared on session shutdown, unlike a raw `setInterval`.
  setInterval: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  [key: string]: unknown;
}

/** The slice of Bun's `Subprocess` this extension actually relies on. */
interface FleetSubprocess {
  kill: () => void;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | number | null;
  stderr: ReadableStream<Uint8Array> | number | null;
}

type ToolUpdate = (update: { content: Array<{ type: "text"; text: string }> }) => void;


function isMissingBinaryError(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === "ENOENT") return true;
  const message = String((err as { message?: unknown } | undefined)?.message ?? err ?? "");
  return /ENOENT|command not found|not found on \$?PATH/i.test(message);
}

export default function fleetExtension(pi: ExtensionAPI) {
  // Sessions outside herdr have nothing to talk to: fleet's state, worktrees,
  // and worker panes are all herdr concepts. Register nothing there.
  if (!process.env.HERDR_ENV) return;

  const z = pi.zod;
  const fleetBin = process.env.FLEET_BIN || "fleet";

  /**
   * Runs `fleet <args>` to completion via `pi.exec` and returns stdout.
   * Every tool except `fleet_join` uses this: a non-zero exit is always a
   * real failure here, so it throws `stderr || stdout`. `fleet_join` (and
   * `fleet_ask`, for progress) use `runFleetStreaming` below instead.
   */
  async function runFleet(
    args: string[],
    ctx: FleetToolCtx,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let result: FleetExecResult;
    try {
      result = (await pi.exec(fleetBin, args, { signal, cwd: ctx.cwd })) as FleetExecResult;
    } catch (err) {
      if (isMissingBinaryError(err)) {
        throw new Error(
          "fleet CLI not found on PATH — is the herdr fleet plugin installed?",
        );
      }
      throw err;
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return result.stdout;
  }

  /**
   * Runs `fleet <args>` with `Bun.spawn` so stdout can be forwarded through
   * `onUpdate` as it arrives — `fleet join`/`fleet ask` print each worker's
   * report the moment it settles rather than all at once at the end. Kills
   * the child on abort. Callers decide how to interpret `exitCode`.
   */
  async function runFleetStreaming(
    args: string[],
    ctx: FleetToolCtx,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdate | undefined,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let child: FleetSubprocess;
    try {
      child = Bun.spawn([fleetBin, ...args], {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as FleetSubprocess;
    } catch (err) {
      if (isMissingBinaryError(err)) {
        throw new Error(
          "fleet CLI not found on PATH — is the herdr fleet plugin installed?",
        );
      }
      throw err;
    }

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // already exited
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderr = "";

    const pump = async (
      stream: ReadableStream<Uint8Array> | number | null | undefined,
      onChunk: (text: string) => void,
    ) => {
      if (!stream || typeof stream === "number") return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
    };

    await Promise.all([
      pump(child.stdout, (chunk) => {
        stdout += chunk;
        onUpdate?.({ content: [{ type: "text", text: stdout }] });
      }),
      pump(child.stderr, (chunk) => {
        stderr += chunk;
      }),
    ]);

    const exitCode = await child.exited;
    if (signal) signal.removeEventListener("abort", onAbort);

    return { stdout, stderr, exitCode };
  }

  // ---------------------------------------------------------------------
  // Background join poller — delivers worker settlement/questions as a
  // non-interrupting aside instead of the orchestrator blocking a tool call.
  // ---------------------------------------------------------------------

  let joinPollTimer: unknown = null;
  let joinPollFailures = 0;
  const joinPollMs = Number(process.env.FLEET_ASIDE_POLL_MS) || 5000;

  /**
   * Starts (once per session) a `ctx.setInterval` tick that runs
   * `fleet join --once` — a single, non-blocking poll pass, never the
   * deadline/`sleep_ms` loop `fleet join` uses on its own. Any output (a
   * settled worker's report, or a filed question) is delivered as a
   * `followUp` custom message: queued behind whatever the orchestrator is
   * doing rather than interrupting it — the same non-interrupting-aside
   * shape `hub`'s own IRC delivery uses for a running recipient — and it
   * starts a turn on its own if the orchestrator is idle. This is what lets
   * the orchestrator keep working after `fleet_spawn` instead of blocking a
   * `fleet_join` tool call for up to an hour. Idempotent, so every
   * orchestrator-side tool can call it unconditionally.
   */
  function ensureJoinPoller(ctx: FleetToolCtx) {
    if (joinPollTimer) return;
    joinPollTimer = ctx.setInterval(async () => {
      let result: FleetExecResult;
      try {
        result = (await pi.exec(fleetBin, ["join", "--once"], { cwd: ctx.cwd })) as FleetExecResult;
      } catch (err) {
        // A transient herdr hiccup shouldn't kill the poller, but a missing
        // binary never recovers on its own — stop instead of erroring on
        // every tick for the rest of the session.
        if (isMissingBinaryError(err) && joinPollTimer) {
          ctx.clearTimer(joinPollTimer);
          joinPollTimer = null;
        }
        return;
      }

      if (result.code !== 0) {
        // Most commonly "not in a git repo" if the boss's cwd changed out
        // from under it. Five in a row means polling itself is broken, not
        // that nothing happened — stop rather than repeat the same die()
        // text as a steer message forever.
        joinPollFailures += 1;
        if (joinPollFailures >= 5 && joinPollTimer) {
          ctx.clearTimer(joinPollTimer);
          joinPollTimer = null;
        }
        return;
      }
      joinPollFailures = 0;

      const text = result.stdout.trim();
      if (!text) return;
      await pi.sendMessage(
        {
          customType: "fleet:update",
          content: text,
          display: true,
          attribution: "user",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }, joinPollMs);
  }

  function cancelled() {
    return { content: [{ type: "text" as const, text: "Cancelled" }] };
  }

  // ---------------------------------------------------------------------
  // Orchestrator-side tools
  // ---------------------------------------------------------------------

  pi.registerTool({
    name: "fleet_boss",
    label: "Fleet Boss",
    description:
      "Claim (or query) this pane's boss handle. Workers address their questions and reports to whichever handle this pane holds at spawn time, so claim it before spawning anything.",
    parameters: z.object({
      name: z.string().optional().describe("Handle to claim; defaults to the repo root's name"),
      steal: z
        .boolean()
        .optional()
        .describe("Take over an already-claimed handle; the holder is renamed aside, not unnamed"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      ensureJoinPoller(ctx);
      const args = ["boss"];
      if (params.name) args.push(params.name);
      if (params.steal) args.push("--steal");
      const stdout = await runFleet(args, ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: { name: params.name ?? null } };
    },
  });

  pi.registerTool({
    name: "fleet_spawn",
    label: "Fleet Spawn",
    description:
      "Create a worktree, start a worker agent in it, and dispatch a task. One worker per branch.",
    parameters: z.object({
      branch: z.string().describe("Branch name for the new worktree"),
      task: z
        .string()
        .optional()
        .describe(
          "Task brief to dispatch; written to a temp file and passed as --task-file so multi-line briefs never get mangled by shell quoting",
        ),
      skill: z
        .string()
        .optional()
        .describe("Skill name; prepends an instruction to read skill://<name> before other work"),
      tier: z
        .enum(["standard", "deep"])
        .optional()
        .describe("Worker model band; mutually exclusive with model"),
      model: z.string().optional().describe("Explicit model selector; mutually exclusive with tier"),
      base: z.string().optional().describe("Branch point override (default: origin/HEAD)"),
      handle: z.string().optional().describe("Explicit worker handle instead of one derived from the branch"),
      layout: z
        .enum(["agent", "full"])
        .optional()
        .describe("Pane layout: agent (default, worker-only) or full (agent + shell + review tabs)"),
      replace: z.boolean().optional().describe("Clear an existing worktree/handle and respawn"),
      no_dispatch: z
        .boolean()
        .optional()
        .describe("Create the worktree and start the agent without assigning work"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      ensureJoinPoller(ctx);
      const args = ["spawn", params.branch];
      let taskFile: string | undefined;
      if (params.task) {
        taskFile = path.join(
          os.tmpdir(),
          `fleet-task-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
        );
        await Bun.write(taskFile, params.task);
        args.push("--task-file", taskFile);
      }
      if (params.skill) args.push("--skill", params.skill);
      if (params.tier) args.push("--tier", params.tier);
      if (params.model) args.push("--model", params.model);
      if (params.base) args.push("--base", params.base);
      if (params.handle) args.push("--handle", params.handle);
      if (params.layout) args.push("--layout", params.layout);
      if (params.replace) args.push("--replace");
      if (params.no_dispatch) args.push("--no-dispatch");
      const stdout = await runFleet(args, ctx, signal);
      return {
        content: [{ type: "text", text: stdout }],
        details: { branch: params.branch, taskFile: taskFile ?? null },
      };
    },
  });

  pi.registerTool({
    name: "fleet_send",
    label: "Fleet Send",
    description:
      "Send a follow-up task to a worker, or (with raw: true) untracked raw steering text — the right way to answer a blocked worker or a fleet_reply question.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe("Send as untracked raw steering instead of a tracked follow-up dispatch"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["send"];
      if (params.raw) args.push("--raw");
      args.push(params.handle, params.text);
      const stdout = await runFleet(args, ctx, signal);
      return {
        content: [{ type: "text", text: stdout }],
        details: { handle: params.handle, raw: !!params.raw },
      };
    },
  });

  pi.registerTool({
    name: "fleet_ask",
    label: "Fleet Ask",
    description:
      "Dispatch a task to one worker and block until it settles. Use only for a genuine follow-up or a serial dependency; never to start a batch — use fleet_spawn + fleet_join for that.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
      timeout_s: z.number().optional().describe("Override the wait timeout, in seconds"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["ask"];
      if (params.timeout_s != null) args.push("--timeout", String(params.timeout_s));
      args.push(params.handle, params.text);
      const { stdout, stderr, exitCode } = await runFleetStreaming(args, ctx, signal, onUpdate);
      if (exitCode !== 0) {
        throw new Error(stderr || stdout);
      }
      return {
        content: [{ type: "text", text: stdout }],
        details: { handle: params.handle, exitCode },
      };
    },
  });

  pi.registerTool({
    name: "fleet_join",
    label: "Fleet Join",
    description:
      "Explicit blocking wait on the given worker handles (or every known worker in this repo if none given). Rarely needed: once fleet_spawn has run, worker reports and questions already arrive on their own as non-interrupting asides — use this only when there is truly nothing else to do and you want to sit until something lands.",
    parameters: z.object({
      handles: z
        .array(z.string())
        .optional()
        .describe("Worker handles to join; omit to join every known worker in this repo"),
      timeout_s: z.number().optional().describe("Override the wait timeout, in seconds"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["join"];
      if (params.timeout_s != null) args.push("--timeout", String(params.timeout_s));
      if (params.handles?.length) args.push(...params.handles);
      const { stdout, stderr, exitCode } = await runFleetStreaming(args, ctx, signal, onUpdate);
      // exit 0 = every named worker joined; exit 1 = the bounded wait timed
      // out with some still outstanding — both are informative results, not
      // tool failures. Anything else is a real error.
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(stderr || stdout);
      }
      return {
        content: [{ type: "text", text: stdout || stderr }],
        details: { exitCode },
      };
    },
  });

  pi.registerTool({
    name: "fleet_ls",
    label: "Fleet List",
    description: "List known fleet workers, their states, kinds, branches, and paths.",
    parameters: z.object({
      all_repos: z.boolean().optional().describe("List workers across every repo, not just this one"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["ls"];
      if (params.all_repos) args.push("--all-repos");
      const stdout = await runFleet(args, ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: {} };
    },
  });

  pi.registerTool({
    name: "fleet_read",
    label: "Fleet Read",
    description:
      "Show the visible terminal of a worker pane. A debugging aid, not a durable way to collect a result — use fleet_join/fleet_ask for that.",
    parameters: z.object({
      handle: z.string(),
      lines: z.number().int().positive().optional().describe("Number of trailing lines to show"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["read", params.handle];
      if (params.lines != null) args.push("-n", String(params.lines));
      const stdout = await runFleet(args, ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: { handle: params.handle } };
    },
  });

  pi.registerTool({
    name: "fleet_reap",
    label: "Fleet Reap",
    description:
      "Remove worker worktrees and records. Refuses a worktree with uncommitted changes unless force is set.",
    parameters: z.object({
      handles: z.array(z.string()).optional().describe("Worker handles to reap"),
      all: z.boolean().optional().describe("Reap every worker in this repo"),
      force: z.boolean().optional().describe("Reap even with uncommitted changes"),
      forget: z.boolean().optional().describe("Drop the record without touching the worktree"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      if (!params.all && (!params.handles || params.handles.length === 0)) {
        throw new Error("fleet_reap requires either a non-empty handles array or all: true");
      }
      const args = ["reap"];
      if (params.all) args.push("--all");
      else args.push(...(params.handles ?? []));
      if (params.force) args.push("--force");
      if (params.forget) args.push("--forget");
      const stdout = await runFleet(args, ctx, signal);
      return {
        content: [{ type: "text", text: stdout }],
        details: { handles: params.handles ?? [], all: !!params.all },
      };
    },
  });

  pi.registerTool({
    name: "fleet_broadcast",
    label: "Fleet Broadcast",
    description:
      "Send untracked raw steering text to every live worker in this repo. Use for wave-wide notices, not for a task.",
    parameters: z.object({
      text: z.string(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const stdout = await runFleet(["broadcast", params.text], ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: {} };
    },
  });

  pi.registerTool({
    name: "fleet_dm",
    label: "Fleet DM",
    description: "Send untracked raw steering text directly to one other fleet member.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const stdout = await runFleet(["dm", params.handle, params.text], ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: { handle: params.handle } };
    },
  });

  pi.registerTool({
    name: "fleet_keys",
    label: "Fleet Keys",
    description:
      "Send terminal keys into a worker's interactive UI — the way to unblock an approval prompt fleet_read shows as stuck.",
    parameters: z.object({
      handle: z.string(),
      keys: z.array(z.string()).min(1).describe("Key names, passed through to herdr agent send-keys"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const stdout = await runFleet(["keys", params.handle, ...params.keys], ctx, signal);
      return {
        content: [{ type: "text", text: stdout }],
        details: { handle: params.handle, keys: params.keys },
      };
    },
  });

  // ---------------------------------------------------------------------
  // Worker-side tools. Registered unconditionally: the CLI itself arbitrates
  // by pane identity and dies with a clear error when the pane isn't a
  // registered worker, so no session-role detection is needed here.
  // ---------------------------------------------------------------------

  pi.registerTool({
    name: "fleet_report",
    label: "Fleet Report",
    description:
      "File this worker's report to disk (worker-side). Overwritten only by this worker's own later report.",
    parameters: z.object({
      text: z.string().optional().describe("Report text; mutually exclusive with file"),
      file: z.string().optional().describe("Path to a file containing the report; mutually exclusive with text"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const hasText = typeof params.text === "string" && params.text.length > 0;
      const hasFile = typeof params.file === "string" && params.file.length > 0;
      if (hasText === hasFile) {
        throw new Error("fleet_report requires exactly one of text or file");
      }
      const args = hasFile ? ["report", "-f", params.file as string] : ["report", params.text as string];
      const stdout = await runFleet(args, ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: {} };
    },
  });

  pi.registerTool({
    name: "fleet_reply",
    label: "Fleet Reply",
    description:
      "File a question to the boss and interrupt its pane (worker-side). Use when blocked on a decision only the orchestrator can make.",
    parameters: z.object({
      text: z.string(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const stdout = await runFleet(["reply", params.text], ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: {} };
    },
  });
}
