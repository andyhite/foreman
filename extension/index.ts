import type {
  ExtensionAPI,
  ExtensionToolContext,
  ExtensionToolUpdate,
  InferShape,
  ZodObject,
  ZodRawShape,
} from "@oh-my-pi/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `@oh-my-pi/pi-coding-agent` is not an installed dependency of this plugin
 * (it is provided by the omp runtime that loads and executes this module),
 * so the real `ExtensionAPI`/`ExtensionToolContext` types are not
 * resolvable by `tsc` without a local ambient declaration — see
 * `extension/pi-coding-agent.d.ts`, which types the slice this file
 * actually calls and which this file imports its context/update/shape
 * types from directly rather than re-declaring structurally-identical
 * local copies. `import type` above is erased before execution and never
 * attempts module resolution at runtime, so it is safe to keep for
 * documentation/IDE purposes. `ForemanExecResult` below is the one
 * exception: `ExtensionAPI.exec` deliberately types its result as
 * `unknown` (the real return shape isn't resolvable here either), so every
 * call site casts through this local shape instead of the ambient module
 * declaring one for it.
 */
interface ForemanExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

function isMissingBinaryError(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === "ENOENT") return true;
  const message = String((err as { message?: unknown } | undefined)?.message ?? err ?? "");
  return /ENOENT|command not found|not found on \$?PATH/i.test(message);
}

interface CommandPrompt {
  name: string;
  description: string;
  body: string;
}

/**
 * Reads `command-prompts/*.md` and returns each as a registerable command.
 * These are deliberately NOT named `commands/` — that directory name is one
 * of the conventions omp's `omp-plugins` capability provider auto-scans for
 * npm/link-installed plugins, and that provider (unlike the `claude-plugins`
 * one marketplace installs use) does not prefix discovered commands with the
 * plugin name. A `commands/boss.md` would surface as bare `/boss`,
 * invisibly unscoped and one collision away from any other installed
 * plugin's same-named command. Loading them here and registering under
 * `foreman:<name>` keeps the namespace under every install mechanism.
 *
 * Exported for `bun test` coverage of the frontmatter parsing below — the
 * only pure logic in this file complex enough to break silently.
 */
export function loadCommandPrompts(dir: string = path.join(import.meta.dir, "..", "command-prompts")): CommandPrompt[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  // A bad file must not take down every command: this runs from the
  // top-level `for` in the extension factory, so one throw here breaks the
  // whole plugin. Reachable today: Emacs' lock file `.#boss.md` matches the
  // `.md` filter above and is a broken symlink, so merely opening
  // `command-prompts/boss.md` in Emacs crashes the plugin on next load.
  return files.flatMap((file) => {
    const name = file.slice(0, -3);
    // A file whose derived name isn't a clean command-name segment (dotfile,
    // space, `..`) would register as `foreman:<garbage>` instead of failing
    // loudly — skip it rather than exposing a broken/unexpected command.
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return [];
    try {
      const raw = readFileSync(path.join(dir, file), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!match) return [{ name, description: name, body: raw.trim() }];
      const [, frontmatter, rest] = match;
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      return [
        {
          name,
          description: descMatch ? descMatch[1].trim() : name,
          body: rest.replace(/^\n+/, ""),
        },
      ];
    } catch {
      return [];
    }
  });
}

export type DeliverOutcome = "delivered" | "empty" | "missing-binary" | "error";

/**
 * What a `pickup` attempt found, already classified — the caller (real
 * `pi.exec`, or a test's stub) does the try/catch and exit-code reading;
 * `createDeliverer` below only ever sees this shape. Keeping the
 * subprocess boundary here, rather than inside the state machine, is what
 * lets the coalescing logic below be tested without mocking `pi.exec`.
 */
export type PickupResult =
  | { kind: "delivered"; text: string }
  | { kind: "empty" }
  | { kind: "missing-binary" }
  | { kind: "error" };

export interface Deliverer {
  deliverOnce(cwd: string): Promise<DeliverOutcome>;
  deliverInbound(cwd: string): Promise<DeliverOutcome>;
}

/**
 * Builds the `deliverOnce`/`deliverInbound` pair around an injected
 * `pickup`/`publish`, so the coalescing state machine — the part that can
 * silently double-inject or drop a report — is testable without a real
 * `foreman` binary or a mock of the whole `pi` object. Exported for
 * `bun test`; `foremanExtension` below is the only non-test caller.
 */
export function createDeliverer(
  pickup: (cwd: string) => Promise<PickupResult>,
  publish: (text: string) => Promise<void>,
): Deliverer {
  let deliverInFlight = false;
  let deliverPending = false;

  /**
   * One `pickup` pass — a single, non-blocking check of this pane's own
   * inbound state, never the deadline/`sleep_ms` loop `foreman join` uses
   * — injecting its stdout as a `followUp` custom message if it printed
   * anything: queued behind whatever the agent is doing rather than
   * interrupting it, and starting a turn on its own if the agent is idle.
   */
  async function deliverOnce(cwd: string): Promise<DeliverOutcome> {
    const result = await pickup(cwd);
    if (result.kind !== "delivered") return result.kind;
    await publish(result.text);
    return "delivered";
  }

  /**
   * Serialises `deliverOnce` across its two callers, the push listener and
   * the timer tick. Concurrency has to be excluded: a hung pickup has no
   * timeout of its own, so a second overlapping call would pile another
   * stuck child on top of the first.
   *
   * A wake arriving mid-pickup is coalesced rather than dropped. Dropping it
   * loses the delivery outright whenever the in-flight pass had already read
   * state before the counter it would have been told about changed, leaving
   * the payload to sit until the 60s anomaly sweep — the exact wait the bus
   * exists to remove. One re-run covers any number of queued wakes, because
   * a single pickup drains everything pending in one pass.
   */
  async function deliverInbound(cwd: string): Promise<DeliverOutcome> {
    if (deliverInFlight) {
      deliverPending = true;
      return "empty";
    }
    deliverInFlight = true;
    try {
      let outcome: DeliverOutcome;
      do {
        deliverPending = false;
        outcome = await deliverOnce(cwd);
        // A missing binary or a hard error will not resolve on an immediate
        // retry; re-run only where new state could genuinely be waiting.
      } while (deliverPending && (outcome === "delivered" || outcome === "empty"));
      return outcome;
    } finally {
      deliverInFlight = false;
      deliverPending = false;
    }
  }

  return { deliverOnce, deliverInbound };
}

export default function foremanExtension(pi: ExtensionAPI) {
  // Sessions outside herdr have nothing to talk to: foreman's state, worktrees,
  // and worker panes are all herdr concepts. Register nothing there.
  if (!process.env.HERDR_ENV) return;

  const z = pi.zod;
  const foremanBin = process.env.FOREMAN_BIN || "foreman";

  /**
   * Runs `foreman <args>` to completion via `pi.exec` and returns both
   * streams joined. Every tool except `foreman_join`/`foreman_ask` uses this:
   * a non-zero exit is always a real failure here, so it throws with the
   * subcommand and exit code — unless `allowNonZero` is set, for the one
   * subcommand (`doctor`) whose non-zero exit is itself the useful result.
   */
  async function runForeman(
    args: string[],
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    options?: { allowNonZero?: boolean },
  ): Promise<string> {
    let result: ForemanExecResult;
    try {
      result = (await pi.exec(foremanBin, args, { signal, cwd: ctx.cwd })) as ForemanExecResult;
    } catch (err) {
      if (isMissingBinaryError(err)) {
        throw new Error(
          "foreman CLI not found on PATH — is the herdr foreman plugin installed?",
        );
      }
      throw err;
    }
    if (result.code !== 0 && !options?.allowNonZero) {
      // Cancellation kills the child leaving stderr/stdout empty — throwing
      // "" would surface as a blank, unactionable tool error instead of the
      // abort the caller already knows about via `signal`.
      if (result.killed || signal?.aborted) {
        throw new Error(`foreman ${args[0]} cancelled`);
      }
      throw new Error(
        `foreman ${args[0]} exited ${result.code}: ${result.stderr || result.stdout || "(no output)"}`,
      );
    }
    // note() (herdr/bin/foreman:63) routes every human-facing diagnostic —
    // including the first-dispatch pickup warning foreman_spawn depends on —
    // to stderr, and send/keys/dm/reap write nothing to stdout at all.
    // Returning stdout alone silently discarded those on every success.
    return [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
  }

  /**
   * Runs `foreman <args>` with `Bun.spawn` so stdout can be forwarded through
   * `onUpdate` as it arrives — `foreman join`/`foreman ask` print each worker's
   * report the moment it settles rather than all at once at the end. Kills
   * the child on abort. Callers decide how to interpret `exitCode`.
   */
  async function runForemanStreaming(
    args: string[],
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    onUpdate: ExtensionToolUpdate | undefined,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([foremanBin, ...args], {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      if (isMissingBinaryError(err)) {
        throw new Error(
          "foreman CLI not found on PATH — is the herdr foreman plugin installed?",
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

    try {
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
      return { stdout, stderr, exitCode };
    } finally {
      // onUpdate can throw (e.g. host truncates an oversized turn). Without
      // this, that throw skips both the listener removal below (leaking it
      // for the rest of the session) and `await child.exited`, leaving the
      // child running and an orphaned `foreman join` polling herdr for up
      // to FOREMAN_WAIT_TIMEOUT_MS — an hour — with nothing to reap it.
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
  }

  // ---------------------------------------------------------------------
  // Inbound delivery — the sidecar (`foreman bus`) only exists when this
  // plugin is loaded: it is registered as this plugin's own MCP server in
  // `.omp-plugin/plugin.json`, not user-global, so sidecar-present implies
  // this handler-present by construction, with no separate arming
  // handshake to keep in sync. The sidecar publishes its pid and blocks on
  // a pipe read; a writer (a worker's `foreman report`/`reply`, or a
  // boss's `dispatch_to`) resolves this pane's pid via herdr and sends it
  // `SIGUSR1` directly — the signal *is* the liveness check. The sidecar's
  // USR1 trap then emits `notifications/foreman/wake` on stdout, which the
  // `mcp_notification` listener below turns into a `deliverInbound` call:
  // the happy path is a direct signal, not a poll. `deliverInbound` also
  // backs the `session_start` timer (`ensureJoinPoller`), sharing one
  // in-flight guard so a wake landing mid-tick (or vice versa) can never
  // inject the same `foreman pickup` output twice. The timer survives only
  // as the anomaly net a signal cannot express: a worker that died without
  // ever reporting, or a signal sent to a pid that's since gone.
  // ---------------------------------------------------------------------

  const deliverer = createDeliverer(
    async (cwd) => {
      let result: ForemanExecResult;
      try {
        result = (await pi.exec(foremanBin, ["pickup"], { cwd })) as ForemanExecResult;
      } catch (err) {
        return isMissingBinaryError(err) ? { kind: "missing-binary" } : { kind: "error" };
      }
      // Exit 3 means nothing to deliver — not a failure, just nothing to do.
      if (result.code === 3) return { kind: "empty" };
      if (result.code !== 0) return { kind: "error" };
      const text = result.stdout.trim();
      return text ? { kind: "delivered", text } : { kind: "empty" };
    },
    async (text) => {
      await pi.sendMessage(
        {
          customType: "Foreman Update",
          content: text,
          display: true,
          attribution: "user",
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  );

  let joinPollTimer: unknown = null;
  let joinPollFailures = 0;
  const joinPollMs = Number(process.env.FOREMAN_ASIDE_POLL_MS) || 60000;

  /**
   * Starts (once per session, from `session_start` below) a
   * `ctx.setInterval` tick that calls `deliverInbound`. A missing binary or
   * five consecutive real errors stops the *timer* (polling itself is
   * broken, or will never work); a push-triggered `deliverInbound` call
   * must never be able to trip this — the listener below stays armed for
   * the life of the session regardless of any one pickup's outcome.
   */
  function ensureJoinPoller(ctx: ExtensionToolContext) {
    if (joinPollTimer) return;
    joinPollTimer = ctx.setInterval(async () => {
      const outcome = await deliverer.deliverInbound(ctx.cwd);
      if (outcome === "missing-binary") {
        // A transient herdr hiccup shouldn't kill the poller, but a missing
        // binary never recovers on its own — stop instead of erroring on
        // every tick for the rest of the session.
        if (joinPollTimer) {
          ctx.clearTimer(joinPollTimer);
          joinPollTimer = null;
        }
        return;
      }
      if (outcome === "empty") {
        // Nothing to deliver right now. Not a failure — park the timer so
        // an idle repo doesn't spend a subprocess every tick forever; the
        // next `session_start` (a new pane/session) calls `ensureJoinPoller`
        // again and restarts it. Parking is safe because a push already
        // delivered anything that mattered — nothing is lost while this
        // loop is stopped.
        if (joinPollTimer) {
          ctx.clearTimer(joinPollTimer);
          joinPollTimer = null;
        }
        return;
      }
      if (outcome === "error") {
        // Most commonly "not in a git repo" if the pane's cwd changed out
        // from under it — a registered worker pane's own `pickup` now exits
        // 3 ("empty"), not an error, so this branch no longer accumulates
        // on the single most common poller tick. Five in a row still means
        // polling itself is broken, not that nothing happened — stop rather
        // than repeat the same unactionable failure as a steer message
        // forever.
        joinPollFailures += 1;
        if (joinPollFailures >= 5 && joinPollTimer) {
          ctx.clearTimer(joinPollTimer);
          joinPollTimer = null;
        }
        return;
      }
      joinPollFailures = 0;
    }, joinPollMs);
  }

  // Armed from `session_start`, not lazily from a tool handler: a worker
  // session never calls a boss-side tool, so a lazily-armed listener would
  // leave every worker deaf to its own dispatches. `mcp_notification` fires
  // for every server this session has wired up, so the `server`/`method`
  // filter is required, not defensive — anything else on the bus is not
  // this extension's concern.
  pi.on("mcp_notification", (event, ctx) => {
    if (event.server !== "foreman" || event.method !== "notifications/foreman/wake") return;
    void deliverer.deliverInbound(ctx.cwd);
  });

  pi.on("session_start", (_event, ctx) => {
    ensureJoinPoller(ctx);
  });

  function cancelled() {
    return { content: [{ type: "text" as const, text: "Cancelled" }] };
  }

  /**
   * Every tool whose `execute` is exactly: check `signal.aborted`, build an
   * argv from `params`, run it through `runForeman`, wrap the stdout as a
   * text result. `args`/`details` stay adjacent to the `description`/`zod`
   * schema they correspond to, unlike a data table of entries, because
   * those are the model-facing API and need to stay legible next to the
   * tool they describe. Tools whose body isn't this shape (a `finally`, a
   * stream, a branch on which of two mutually-exclusive params was given)
   * are left as explicit `pi.registerTool` calls below instead of being
   * contorted through extra flags here — a helper that needs escape
   * hatches for every outlier is worse than the duplication it removes.
   */
  function registerForemanTool<Shape extends ZodRawShape>(config: {
    name: string;
    label: string;
    description: string;
    parameters: ZodObject<Shape>;
    args: (params: InferShape<Shape>) => string[];
    details?: (params: InferShape<Shape>) => Record<string, unknown>;
  }) {
    pi.registerTool({
      name: config.name,
      label: config.label,
      description: config.description,
      parameters: config.parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) return cancelled();
        const stdout = await runForeman(config.args(params), ctx, signal);
        return { content: [{ type: "text", text: stdout }], details: config.details?.(params) ?? {} };
      },
    });
  }

  // ---------------------------------------------------------------------
  // Boss-side tools
  // ---------------------------------------------------------------------

  registerForemanTool({
    name: "foreman_boss",
    label: "Foreman Boss",
    description:
      "Claim (or query) this pane's boss handle. Workers address their questions and reports to whichever handle this pane holds at spawn time, so claim it before spawning anything.",
    parameters: z.object({
      name: z.string().optional().describe("Handle to claim; defaults to the repo root's name"),
      steal: z
        .boolean()
        .optional()
        .describe("Take over an already-claimed handle; the holder is renamed aside, not unnamed"),
    }),
    args: (params) => {
      const args = ["boss"];
      if (params.name) args.push(params.name);
      if (params.steal) args.push("--steal");
      return args;
    },
    details: (params) => ({ name: params.name ?? null }),
  });

  pi.registerTool({
    name: "foreman_spawn",
    label: "Foreman Spawn",
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
      skills: z
        .array(z.string())
        .optional()
        .describe(
          "Skill names; each prepends an instruction to read skill://<name> before other work, in array order.",
        ),
      role: z
        .string()
        .optional()
        .describe(
          "One role name resolved through foreman's own config (see: foreman roles). Its skill precedes skills in the worker prompt; the role may also default tier/model unless tier or model is set here.",
        ),
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
      const args = ["spawn", params.branch];
      let taskFile: string | undefined;
      if (params.task) {
        taskFile = path.join(
          os.tmpdir(),
          `foreman-task-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
        );
        await Bun.write(taskFile, params.task);
        args.push("--task-file", taskFile);
      }
      for (const skill of params.skills ?? []) args.push("--skill", skill);
      if (params.role) args.push("--role", params.role);
      if (params.tier) args.push("--tier", params.tier);
      if (params.model) args.push("--model", params.model);
      if (params.base) args.push("--base", params.base);
      if (params.handle) args.push("--handle", params.handle);
      if (params.layout) args.push("--layout", params.layout);
      if (params.replace) args.push("--replace");
      if (params.no_dispatch) args.push("--no-dispatch");
      // herdr/bin/foreman:946 only reads --task-file; it never owns or
      // deletes it, so leaving this out leaked a full copy of every task
      // brief into os.tmpdir() for the life of the machine.
      try {
        const stdout = await runForeman(args, ctx, signal);
        return {
          content: [{ type: "text", text: stdout }],
          details: { branch: params.branch, taskFile: taskFile ?? null },
        };
      } finally {
        if (taskFile) await unlink(taskFile).catch(() => {});
      }
    },
  });

  registerForemanTool({
    name: "foreman_send",
    label: "Foreman Send",
    description:
      "Send a follow-up task to a worker, or (with raw: true) untracked raw steering text — the right way to answer a blocked worker or a foreman_reply question.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe("Send as untracked raw steering instead of a tracked follow-up dispatch"),
    }),
    args: (params) => {
      const args = ["send"];
      if (params.raw) args.push("--raw");
      args.push(params.handle, params.text);
      return args;
    },
    details: (params) => ({ handle: params.handle, raw: !!params.raw }),
  });

  pi.registerTool({
    name: "foreman_ask",
    label: "Foreman Ask",
    description:
      "Dispatch a task to one worker and block until it settles. Use only for a genuine follow-up or a serial dependency; never to start a batch — use foreman_spawn + foreman_join for that.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
      timeout_s: z.number().int().positive().optional().describe("Override the wait timeout, in seconds"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["ask"];
      if (params.timeout_s != null) args.push("--timeout", String(params.timeout_s));
      args.push(params.handle, params.text);
      const { stdout, stderr, exitCode } = await runForemanStreaming(args, ctx, signal, onUpdate);
      if (exitCode !== 0) {
        // cmd_ask runs cmd_send BEFORE the join wait (herdr/bin/foreman:1412-1413),
        // so a killed/silent child (empty stdout and stderr) would otherwise
        // throw a blank error for work that already dispatched and is running.
        throw new Error(stderr || stdout || `foreman ask exited ${exitCode}: (no output)`);
      }
      return {
        content: [{ type: "text", text: stdout }],
        details: { handle: params.handle, exitCode },
      };
    },
  });

  pi.registerTool({
    name: "foreman_join",
    label: "Foreman Join",
    description:
      "Explicit blocking wait on the given worker handles (or every known worker in this repo if none given). Rarely needed: once foreman_spawn has run, worker reports and questions already arrive on their own by pushing straight to this pane — use this only for an explicit re-read of one worker or a deliberate blocking wait.",
    parameters: z.object({
      handles: z
        .array(z.string())
        .optional()
        .describe("Worker handles to join; omit to join every known worker in this repo"),
      timeout_s: z.number().int().positive().optional().describe("Override the wait timeout, in seconds"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const args = ["join"];
      if (params.timeout_s != null) args.push("--timeout", String(params.timeout_s));
      if (params.handles?.length) args.push(...params.handles);
      const { stdout, stderr, exitCode } = await runForemanStreaming(args, ctx, signal, onUpdate);
      // exit 0 = every named worker joined; exit 1 = the bounded wait timed
      // out with some still outstanding — both are informative results, not
      // tool failures. Anything else is a real error.
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(stderr || stdout);
      }
      // stdout alone drops cmd_join's "gave up after Ns; still working: ..."
      // stderr line whenever ANY worker settled (stdout is then non-empty),
      // hiding a partial timeout as if every handle had joined cleanly.
      return {
        content: [{ type: "text", text: [stdout, stderr].filter((s) => s.trim()).join("\n") }],
        details: { exitCode },
      };
    },
  });

  registerForemanTool({
    name: "foreman_ls",
    label: "Foreman List",
    description: "List known foreman workers, their states, kinds, branches, and paths.",
    parameters: z.object({
      all_repos: z.boolean().optional().describe("List workers across every repo, not just this one"),
    }),
    args: (params) => {
      const args = ["ls"];
      if (params.all_repos) args.push("--all-repos");
      return args;
    },
  });

  registerForemanTool({
    name: "foreman_read",
    label: "Foreman Read",
    description:
      "Show the visible terminal of a worker pane. A debugging aid, not a durable way to collect a result — use foreman_join/foreman_ask for that.",
    parameters: z.object({
      handle: z.string(),
      lines: z.number().int().positive().optional().describe("Number of trailing lines to show"),
    }),
    args: (params) => {
      const args = ["read", params.handle];
      if (params.lines != null) args.push("-n", String(params.lines));
      return args;
    },
    details: (params) => ({ handle: params.handle }),
  });

  registerForemanTool({
    name: "foreman_reap",
    label: "Foreman Reap",
    description:
      "Remove worker worktrees and records. Refuses a worktree with uncommitted changes unless force is set.",
    parameters: z.object({
      handles: z.array(z.string()).optional().describe("Worker handles to reap"),
      all: z.boolean().optional().describe("Reap every worker in this repo"),
      force: z.boolean().optional().describe("Reap even with uncommitted changes"),
      forget: z.boolean().optional().describe("Drop the record without touching the worktree"),
    }),
    args: (params) => {
      if (!params.all && (!params.handles || params.handles.length === 0)) {
        throw new Error("foreman_reap requires either a non-empty handles array or all: true");
      }
      const args = ["reap"];
      if (params.all) args.push("--all");
      else args.push(...(params.handles ?? []));
      if (params.force) args.push("--force");
      if (params.forget) args.push("--forget");
      return args;
    },
    details: (params) => ({ handles: params.handles ?? [], all: !!params.all }),
  });

  registerForemanTool({
    name: "foreman_broadcast",
    label: "Foreman Broadcast",
    description:
      "Send untracked raw steering text to every live worker in this repo. Use for wave-wide notices, not for a task.",
    parameters: z.object({
      text: z.string(),
    }),
    args: (params) => ["broadcast", params.text],
  });

  registerForemanTool({
    name: "foreman_dm",
    label: "Foreman DM",
    description: "Send untracked raw steering text directly to one other foreman member.",
    parameters: z.object({
      handle: z.string(),
      text: z.string(),
    }),
    args: (params) => ["dm", params.handle, params.text],
    details: (params) => ({ handle: params.handle }),
  });

  registerForemanTool({
    name: "foreman_keys",
    label: "Foreman Keys",
    description:
      "Send terminal keys into a worker's interactive UI — the way to unblock an approval prompt foreman_read shows as stuck.",
    parameters: z.object({
      handle: z.string(),
      keys: z.array(z.string()).min(1).describe("Key names, passed through to herdr agent send-keys"),
    }),
    args: (params) => ["keys", params.handle, ...params.keys],
    details: (params) => ({ handle: params.handle, keys: params.keys }),
  });

  pi.registerTool({
    name: "foreman_doctor",
    label: "Foreman Doctor",
    description:
      "Diagnose why foreman isn't working — checks herdr, git, and worktree state. The designated \"why is nothing working\" tool; run this first when another tool fails unexpectedly.",
    parameters: z.object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      // doctor exits nonzero to report a failed check — that is the normal
      // "here's what's wrong" result callers need to see, not a tool error,
      // so this is the one caller that passes allowNonZero.
      const stdout = await runForeman(["doctor"], ctx, signal, { allowNonZero: true });
      return { content: [{ type: "text", text: stdout }] };
    },
  });

  registerForemanTool({
    name: "foreman_roles",
    label: "Foreman Roles",
    description:
      "List the role names foreman_spawn's role parameter accepts, the skill each resolves to, any model each defaults to, and that skill's own description as a hint for what the role is for.",
    parameters: z.object({}),
    args: () => ["roles"],
  });

  // ---------------------------------------------------------------------
  // Worker-side tools. Registered unconditionally: the CLI itself arbitrates
  // by pane identity and dies with a clear error when the pane isn't a
  // registered worker, so no session-role detection is needed here.
  // ---------------------------------------------------------------------

  pi.registerTool({
    name: "foreman_report",
    label: "Foreman Report",
    description:
      "File this worker's report to disk (worker-side). Also pushes it straight to the boss's pane immediately; the file is the fallback the boss's sweeper picks up if that push can't reach it. Overwritten only by this worker's own later report.",
    parameters: z.object({
      text: z.string().optional().describe("Report text; mutually exclusive with file"),
      file: z.string().optional().describe("Path to a file containing the report; mutually exclusive with text"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return cancelled();
      const hasText = typeof params.text === "string" && params.text.length > 0;
      const hasFile = typeof params.file === "string" && params.file.length > 0;
      if (hasText === hasFile) {
        throw new Error("foreman_report requires exactly one of text or file");
      }
      const args = hasFile ? ["report", "-f", params.file as string] : ["report", params.text as string];
      const stdout = await runForeman(args, ctx, signal);
      return { content: [{ type: "text", text: stdout }], details: {} };
    },
  });

  registerForemanTool({
    name: "foreman_reply",
    label: "Foreman Reply",
    description:
      "File a question to the boss and push it to the boss's pane (worker-side). Use when blocked on a decision only the boss can make.",
    parameters: z.object({
      text: z.string(),
    }),
    args: (params) => ["reply", params.text],
  });

  // ---------------------------------------------------------------------
  // Boss commands — /foreman:<name>. See loadCommandPrompts() above
  // for why these are registered here instead of left to commands/*.md
  // auto-discovery.
  // ---------------------------------------------------------------------

  for (const prompt of loadCommandPrompts()) {
    pi.registerCommand(`foreman:${prompt.name}`, {
      description: prompt.description,
      handler: async (args: string) => {
        // String-pattern replace() treats $&, $`, $', $$ in the user's own
        // arg text as replacement-pattern syntax, silently corrupting the
        // brief, and only touches the first "$ARGUMENTS" occurrence. The
        // function form disables pattern interpretation and replaceAll
        // covers every occurrence.
        await pi.sendUserMessage(prompt.body.replaceAll("$ARGUMENTS", () => args ?? ""));
      },
    });
  }
}
