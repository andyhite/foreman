// Foreman: dispatch work to peer coding agents that each own a git worktree
// and a branch, and carry their reports and questions back. Five tools,
// identical in every session — no roles, no claiming step, no bash CLI.
//
// Delivery: every message goes through `pi.sendMessage` as a custom message.
// `deliveryOptions` below is the one function that encodes which delivery
// shape each kind gets — change it there, not at each call site.
import type { ExtensionAPI, ExtensionSendOptions, ExtensionToolContext } from "@oh-my-pi/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------

export type MessageKind = "brief" | "send" | "ask";

export interface RepoFacts {
  repoKey: string;
  repoRoot: string;
}

export interface RosterEntry {
  handle: string;
  parent: string | null;
  cwd: string;
  branch: string | null;
  spawnSha: string | null;
  workspaceId: string | null;
  paneId: string | null;
  createdAt: string;
}

export interface Message {
  from: string;
  to: string;
  kind: MessageKind;
  text: string;
  sentAt: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

// ---------------------------------------------------------------------
// Step 9 — exec helper. Every git and herdr call goes through this.
// ---------------------------------------------------------------------

async function run(
  pi: Pick<ExtensionAPI, "exec">,
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { allowNonZero?: boolean },
): Promise<ExecResult> {
  // `pi.exec` is typed `unknown` because the ambient module can't resolve
  // the real shape — this is the one sanctioned boundary cast, and every
  // caller reaches the real shape only through this named result.
  const result = (await pi.exec(cmd, args, { cwd })) as ExecResult;
  if (result.code !== 0 && !opts?.allowNonZero) {
    throw new Error(`${cmd} ${args[0]} exited ${result.code}: ${result.stderr || result.stdout || "(no output)"}`);
  }
  return result;
}

async function herdrJson(pi: Pick<ExtensionAPI, "exec">, args: string[], cwd: string): Promise<unknown> {
  const result = await run(pi, "herdr", args, cwd);
  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    return parsed.result;
  }
  throw new Error(`herdr ${args[0]}: malformed JSON output (no "result" field)`);
}

// ---------------------------------------------------------------------
// Git facts. `repoRoot` is the canonical cwd for every roster comparison —
// never raw `ctx.cwd`, because macOS resolves /tmp to /private/tmp and a
// raw comparison would fail to match a worker to its own entry.
// ---------------------------------------------------------------------

export async function gitFacts(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<RepoFacts | null> {
  try {
    const key = await run(pi, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const root = await run(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
    return { repoKey: key.stdout.trim(), repoRoot: root.stdout.trim() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Step 3 — State layer. Layout:
//   <root>/roster/<handle>.json
//   <root>/mail/<handle>/<file>
//   <root>/done/<handle>/<file>
// ---------------------------------------------------------------------

export function stateSlug(repoKey: string): string {
  return repoKey.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
}

export function stateRoot(repoKey: string): string {
  return process.env.FOREMAN_STATE || join(homedir(), ".foreman", stateSlug(repoKey));
}

export function validHandle(h: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(h);
}

export function deriveHandle(repoRoot: string, taken: string[]): string {
  let base = basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!/^[a-z]/.test(base)) base = `r${base}`.slice(0, 32);
  if (!taken.includes(base)) return base;
  let n = 2;
  let handle = base;
  while (taken.includes(handle)) {
    const suffix = `-${n}`;
    handle = base.slice(0, 32 - suffix.length) + suffix;
    n++;
  }
  return handle;
}

function isRosterEntry(value: unknown): value is RosterEntry {
  if (!value || typeof value !== "object") return false;
  if (!("handle" in value) || typeof value.handle !== "string") return false;
  if (!("cwd" in value) || typeof value.cwd !== "string") return false;
  if (!("createdAt" in value) || typeof value.createdAt !== "string") return false;
  return "parent" in value && "branch" in value && "spawnSha" in value && "workspaceId" in value && "paneId" in value;
}

function readRosterEntry(path: string): RosterEntry {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRosterEntry(parsed)) throw new Error(`foreman: corrupt roster entry at ${path}`);
  return parsed;
}

function writeRosterEntry(root: string, entry: RosterEntry): void {
  mkdirSync(join(root, "roster"), { recursive: true });
  writeFileSync(join(root, "roster", `${entry.handle}.json`), JSON.stringify(entry, null, 2));
}

function loadRoster(root: string): RosterEntry[] {
  const rosterDir = join(root, "roster");
  mkdirSync(rosterDir, { recursive: true });
  return readdirSync(rosterDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readRosterEntry(join(rosterDir, f)));
}

// Used by every tool and by the drain loop. No handle-claiming step: the
// first call from a given repoRoot registers it permanently.
export function resolveSelf(root: string, repoRoot: string): RosterEntry {
  const roster = loadRoster(root);
  const existing = roster.find((r) => r.cwd === repoRoot);
  if (existing) return existing;
  const entry: RosterEntry = {
    handle: deriveHandle(
      repoRoot,
      roster.map((r) => r.handle),
    ),
    parent: null,
    cwd: repoRoot,
    branch: null,
    spawnSha: null,
    workspaceId: null,
    paneId: null,
    createdAt: new Date().toISOString(),
  };
  writeRosterEntry(root, entry);
  return entry;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  if (!("from" in value) || typeof value.from !== "string") return false;
  if (!("to" in value) || typeof value.to !== "string") return false;
  if (!("kind" in value) || (value.kind !== "brief" && value.kind !== "send" && value.kind !== "ask")) return false;
  if (!("text" in value) || typeof value.text !== "string") return false;
  return "sentAt" in value && typeof value.sentAt === "string";
}

// `n` is a module-level counter starting at 0, incremented per enqueue.
// Collision is impossible: two messages from one process differ by `n`,
// messages from different processes differ by `from`.
let enqueueCounter = 0;

export function messageFilename(from: string, n: number): string {
  return `${Date.now()}-${from}-${String(n).padStart(3, "0")}.json`;
}

function enqueue(root: string, message: Message): void {
  const dir = join(root, "mail", message.to);
  mkdirSync(dir, { recursive: true });
  const filename = messageFilename(message.from, enqueueCounter++);
  const tmpPath = join(dir, `.tmp-${filename}`);
  writeFileSync(tmpPath, JSON.stringify(message));
  // Atomic rename: a concurrent drain never reads a partial message.
  renameSync(tmpPath, join(dir, filename));
}

// `to` is on one of `self`'s edges: its parent, or a worker it spawned.
// Structural, not a policy an agent has to remember — worker-to-worker
// messaging is refused here, not by convention.
export function canSend(self: RosterEntry, to: string, roster: RosterEntry[]): boolean {
  if (to === self.parent) return true;
  return roster.some((r) => r.handle === to && r.parent === self.handle);
}

// ---------------------------------------------------------------------
// Step 4 — Drain loop
// ---------------------------------------------------------------------

// omp namespaces `customType` globally, so it must be reverse-domain qualified.
const INBOX_CUSTOM_TYPE = "dev.foreman.inbox";

// Measured on omp v18.0.5 (see docs/ARCHITECTURE.md §8): one probe per shape,
// fired 4s into a 20s tool call and again into a 12s-idle session.
export function deliveryOptions(kind: MessageKind): ExtensionSendOptions {
  // An ask means the sender has already stopped and is waiting for an answer,
  // so it may abort the receiver's in-flight tool call.
  if (kind === "ask") return { deliverAs: "steer", triggerTurn: true };
  // Everything else must not: `followUp` let the 20s tool call run to
  // completion and delivered at the end of the run instead. `nextTurn`
  // measured identically, but degrades to silent loss if `triggerTurn` is
  // ever dropped — a worker pane has no human to type the next prompt.
  return { deliverAs: "followUp", triggerTurn: true };
}

function renderMessage(msg: Message, self: RosterEntry): string {
  if (msg.kind === "brief") {
    return `[foreman:${msg.from}] You are worker @${self.handle}.
Branch: ${self.branch}
Worktree: ${self.cwd}

${msg.text}`;
  }
  if (msg.kind === "ask") {
    return `[foreman:${msg.from}] BLOCKED

${msg.text}`;
  }
  return `[foreman:${msg.from}]

${msg.text}`;
}

export function renderInbox(msgs: Message[], self: RosterEntry): string {
  const rendered = msgs.map((m) => renderMessage(m, self)).join("\n\n---\n\n");
  if (msgs.length > 1) return `[foreman] ${msgs.length} queued messages\n\n${rendered}`;
  return rendered;
}

// Batching must never demote an interrupt: any "ask" in the batch makes the
// whole delivery urgent.
export function urgencyKind(msgs: Message[]): MessageKind {
  return msgs.some((m) => m.kind === "ask") ? "ask" : "send";
}

export interface DrainDeps {
  pi: Pick<ExtensionAPI, "exec" | "sendMessage">;
  cwd: string;
}

// A `sendMessage` slower than the tick interval must never double-deliver —
// guarded by this module-level flag, set in a try/finally.
let draining = false;

export async function drainOnce(deps: DrainDeps): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const facts = await gitFacts(deps.pi, deps.cwd);
    if (!facts) return;
    const root = stateRoot(facts.repoKey);
    const self = resolveSelf(root, facts.repoRoot);
    const mailDir = join(root, "mail", self.handle);
    mkdirSync(mailDir, { recursive: true });
    const files = readdirSync(mailDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length === 0) return;

    const doneDir = join(root, "done", self.handle);
    mkdirSync(doneDir, { recursive: true });
    const msgs: Message[] = [];
    const goodFiles: string[] = [];
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(mailDir, file), "utf8"));
      } catch {
        renameSync(join(mailDir, file), join(doneDir, `${file}.bad`));
        continue;
      }
      // A malformed message must never wedge the mailbox.
      if (!isMessage(parsed)) {
        renameSync(join(mailDir, file), join(doneDir, `${file}.bad`));
        continue;
      }
      msgs.push(parsed);
      goodFiles.push(file);
    }
    if (msgs.length === 0) return;

    await deps.pi.sendMessage(
      {
        customType: INBOX_CUSTOM_TYPE,
        content: renderInbox(msgs, self),
        display: true,
        attribution: "user",
      },
      deliveryOptions(urgencyKind(msgs)),
    );
    // Only after the send resolves. If it throws, the files stay in mail/
    // for the next tick to retry — at-least-once, visible in done/.
    for (const file of goodFiles) {
      renameSync(join(mailDir, file), join(doneDir, file));
    }
  } finally {
    draining = false;
  }
}

// Armed after the first drain rather than inside `session_start`, because the
// mailbox path isn't known until two git calls and a roster read resolve it.
async function armMailWatcher(pi: ExtensionAPI, cwd: string, drain: () => void): Promise<FSWatcher> {
  const { root, self } = await requireSelf(pi, cwd);
  const mailDir = join(root, "mail", self.handle);
  // `fs.watch` throws on a missing directory, and a worker's own mailbox does
  // not exist until someone first writes to it.
  mkdirSync(mailDir, { recursive: true });
  return watch(mailDir, drain);
}

// ---------------------------------------------------------------------
// Tool-shared helpers
// ---------------------------------------------------------------------

async function requireSelf(pi: ExtensionAPI, cwd: string): Promise<{ root: string; repoRoot: string; self: RosterEntry }> {
  const facts = await gitFacts(pi, cwd);
  if (!facts) throw new Error("foreman: not inside a git repository");
  const root = stateRoot(facts.repoKey);
  return { root, repoRoot: facts.repoRoot, self: resolveSelf(root, facts.repoRoot) };
}

function sleep(ctx: ExtensionToolContext, ms: number): Promise<void> {
  // Promise.withResolvers needs an ES2024 lib target; tsconfig.json target
  // is ES2022 and out of scope for this rewrite (plan keeps it unchanged).
  return new Promise((resolve) => {
    const timer = ctx.setInterval(() => {
      ctx.clearTimer(timer);
      resolve();
    }, ms);
  });
}

function readWorktreeCreateResult(value: unknown): { workspaceId: string; paneId: string; worktreeCwd: string } {
  if (
    value &&
    typeof value === "object" &&
    "workspace" in value &&
    value.workspace &&
    typeof value.workspace === "object" &&
    "workspace_id" in value.workspace &&
    typeof value.workspace.workspace_id === "string" &&
    "root_pane" in value &&
    value.root_pane &&
    typeof value.root_pane === "object" &&
    "pane_id" in value.root_pane &&
    typeof value.root_pane.pane_id === "string" &&
    "worktree" in value &&
    value.worktree &&
    typeof value.worktree === "object" &&
    "path" in value.worktree &&
    typeof value.worktree.path === "string"
  ) {
    return { workspaceId: value.workspace.workspace_id, paneId: value.root_pane.pane_id, worktreeCwd: value.worktree.path };
  }
  throw new Error("foreman: herdr worktree create returned an unexpected shape");
}

function readAgentList(value: unknown): Array<{ cwd: string; status: string; paneId: string | undefined }> {
  if (!value || typeof value !== "object" || !("agents" in value) || !Array.isArray(value.agents)) return [];
  const agents: Array<{ cwd: string; status: string; paneId: string | undefined }> = [];
  for (const item of value.agents) {
    if (
      item &&
      typeof item === "object" &&
      "cwd" in item &&
      typeof item.cwd === "string" &&
      "agent_status" in item &&
      typeof item.agent_status === "string"
    ) {
      const paneId = "pane_id" in item && typeof item.pane_id === "string" ? item.pane_id : undefined;
      agents.push({ cwd: item.cwd, status: item.agent_status, paneId });
    }
  }
  return agents;
}

// `herdr agent start` exits 1 on its own internal readiness-detection
// timeout, but the agent can still have finished starting a moment later —
// the CLI's poll and the pane's actual boot time race. Trusting that exit
// code alone produces false "no agent started" failures for agents that are
// in fact live. `herdr agent list` reports ground truth: an entry for our
// pane means the agent was detected, whatever `start` returned.
async function agentLiveOnPane(pi: Pick<ExtensionAPI, "exec">, repoRoot: string, paneId: string): Promise<boolean> {
  try {
    const agents = readAgentList(await herdrJson(pi, ["agent", "list"], repoRoot));
    return agents.some((a) => a.paneId === paneId);
  } catch {
    return false;
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function pendingCount(root: string, handle: string): number {
  const mailDir = join(root, "mail", handle);
  if (!existsSync(mailDir)) return 0;
  return readdirSync(mailDir).filter((f) => f.endsWith(".json")).length;
}

// ---------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------

export default function foremanExtension(pi: ExtensionAPI): void {
  const z = pi.zod;
  let timer: unknown;
  let watcher: FSWatcher | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (timer !== undefined) ctx.clearTimer(timer);
    watcher?.close();
    watcher = undefined;

    // `drainOnce` is async, so it never throws synchronously — it rejects, and
    // an unhandled rejection is fatal in Bun. Swallowing is safe because a
    // failed drain leaves its mail in `mail/`, so the next trigger retries it.
    const drain = () => void drainOnce({ pi, cwd: ctx.cwd }).catch(() => {});

    // The interval is now a backstop, not the delivery path: `fs.watch` fires
    // in single-digit milliseconds, where a 250 ms poll added 125 ms of
    // latency to the average message. It cannot be the only trigger, because
    // `foreman_reap` deletes mailbox directories and a deleted directory kills
    // its watcher for good, and because the watcher can only be armed once two
    // git calls have resolved the mailbox path.
    timer = ctx.setInterval(drain, Number(process.env.FOREMAN_BACKSTOP_MS) || 5000);

    // Covers mail that arrived while the process was down, and mail that
    // arrives before the watcher is armed.
    drain();

    void armMailWatcher(pi, ctx.cwd, drain)
      .then((armed) => {
        watcher = armed;
      })
      // Arming needs git and a writable state dir; if either is missing the
      // backstop interval is still a correct, slower drain.
      .catch(() => {});
  });

  pi.registerTool({
    name: "foreman_spawn",
    label: "Foreman Spawn",
    description:
      "Spawn a peer coding agent into a fresh git worktree and branch, and dispatch its first task. Requires herdr.",
    parameters: z.object({
      handle: z
        .string()
        .describe(
          "Short name for the worker: lowercase letters, digits, hyphens, underscores; must start with a letter. This is how you address it later.",
        ),
      branch: z.string().describe("Branch the worker will own. Created fresh from base."),
      base: z.string().optional().describe("Ref the branch starts from. Defaults to your checkout's current HEAD."),
      brief: z
        .string()
        .describe(
          "The complete task. The worker starts with no conversation history, so state the goal, the files, and what done looks like.",
        ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!validHandle(params.handle)) {
        throw new Error(
          `foreman: invalid handle "${params.handle}" — use lowercase letters, digits, - or _, starting with a letter, max 32 chars`,
        );
      }
      const facts = await gitFacts(pi, ctx.cwd);
      if (!facts) throw new Error("foreman: not inside a git repository");
      const root = stateRoot(facts.repoKey);
      const rosterPath = join(root, "roster", `${params.handle}.json`);
      if (existsSync(rosterPath)) {
        const existing = readRosterEntry(rosterPath);
        throw new Error(`foreman: handle ${params.handle} is already taken by the worker on branch ${existing.branch}`);
      }
      if (process.env.HERDR_ENV !== "1") {
        throw new Error("foreman: requires herdr — worktree panes are how workers get a terminal. Start a herdr session first.");
      }

      const self = resolveSelf(root, facts.repoRoot);
      const base = params.base ?? (await run(pi, "git", ["rev-parse", "HEAD"], facts.repoRoot)).stdout.trim();
      const spawnSha = (await run(pi, "git", ["rev-parse", base], facts.repoRoot)).stdout.trim();
      const worktreePath = join(dirname(facts.repoRoot), `${basename(facts.repoRoot)}-${params.handle}`);

      const created = await herdrJson(
        pi,
        [
          "worktree",
          "create",
          "--cwd",
          facts.repoRoot,
          "--branch",
          params.branch,
          "--base",
          base,
          "--path",
          worktreePath,
          "--no-focus",
        ],
        facts.repoRoot,
      );
      const { workspaceId, paneId, worktreeCwd } = readWorktreeCreateResult(created);
      const childRoot = (await run(pi, "git", ["rev-parse", "--show-toplevel"], worktreeCwd)).stdout.trim();

      writeRosterEntry(root, {
        handle: params.handle,
        parent: self.handle,
        cwd: childRoot,
        branch: params.branch,
        spawnSha,
        workspaceId,
        paneId,
        createdAt: new Date().toISOString(),
      });

      // Before starting the agent, so the worker's first drain finds it.
      enqueue(root, { from: self.handle, to: params.handle, kind: "brief", text: params.brief, sentAt: new Date().toISOString() });

      const timeoutMs = Number(process.env.FOREMAN_SPAWN_TIMEOUT_MS) || 60000;
      const deadline = Date.now() + timeoutMs;
      let lastError = "";
      let started = false;
      // `agent start` needs the pane at an interactive shell prompt, and a
      // brand-new worktree pane is not — zsh, mise and direnv take seconds —
      // so early attempts fail fast. Retry against an absolute deadline,
      // never accumulated sleeps.
      while (Date.now() < deadline) {
        try {
          await run(
            pi,
            "herdr",
            ["agent", "start", params.handle, "--kind", "omp", "--pane", paneId, "--timeout", String(Math.max(0, deadline - Date.now()))],
            facts.repoRoot,
          );
          started = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          // `start` reported failure, but it may have lost the race against
          // its own readiness poll rather than actually failed to launch —
          // check ground truth before sleeping and retrying, or we risk
          // running `agent start` a second time against an already-live pane.
          if (await agentLiveOnPane(pi, facts.repoRoot, paneId)) {
            started = true;
            break;
          }
          await sleep(ctx, 1000);
        }
      }
      if (!started && (await agentLiveOnPane(pi, facts.repoRoot, paneId))) {
        started = true;
      }
      if (!started) {
        const seconds = Math.round(timeoutMs / 1000);
        throw new Error(
          `foreman: worktree and branch exist but no agent started within ${seconds}s. Last error: ${lastError}. Clean up with foreman_reap ${params.handle} force=true.`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Spawned @${params.handle} on ${params.branch} at ${childRoot} (pane ${paneId}). Brief queued; it will arrive on the worker's first turn.`,
          },
        ],
        details: { handle: params.handle, branch: params.branch, path: childRoot, paneId, workspaceId, spawnSha },
      };
    },
  });

  pi.registerTool({
    name: "foreman_send",
    label: "Foreman Send",
    description:
      "Send a message to your parent (whoever spawned you) or a worker you spawned. Used for dispatching new tasks, follow-ups, and reports. Never interrupts: a busy receiver finishes its current run first, an idle one wakes immediately.",
    parameters: z.object({
      to: z.string().optional().describe("Handle to send to: a worker you spawned, or omit to send to whoever spawned you."),
      text: z.string().describe("The message. A task, an answer, or a report."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { root, self } = await requireSelf(pi, ctx.cwd);
      const to = params.to ?? self.parent;
      if (!to) throw new Error("foreman: no recipient — you were not spawned by anyone, so pass to= explicitly");
      const roster = loadRoster(root);
      if (!canSend(self, to, roster)) {
        const children = roster
          .filter((r) => r.parent === self.handle)
          .map((r) => r.handle)
          .join(", ");
        throw new Error(
          `foreman: ${to} is not on one of your edges. You can send to your parent (${self.parent ?? "none"}) or a worker you spawned (${children || "none"}).`,
        );
      }
      enqueue(root, { from: self.handle, to, kind: "send", text: params.text, sentAt: new Date().toISOString() });
      return {
        content: [{ type: "text", text: `Queued for @${to} (${pendingCount(root, to)} message(s) pending). It arrives after their current run finishes.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "foreman_ask",
    label: "Foreman Ask",
    description:
      "Ask your parent a question you cannot decide yourself. Call this and stop — do not keep working until the answer arrives as a new message.",
    parameters: z.object({
      text: z.string().describe("The decision you need. You will stop after this, so include everything needed to answer."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { root, self } = await requireSelf(pi, ctx.cwd);
      if (!self.parent) throw new Error("foreman: you have no parent to ask — nobody spawned this session");
      enqueue(root, { from: self.handle, to: self.parent, kind: "ask", text: params.text, sentAt: new Date().toISOString() });
      return {
        content: [{ type: "text", text: `Question sent to @${self.parent}. Stop here and end your turn — their answer will arrive as a new message.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "foreman_ls",
    label: "Foreman List",
    description: "List the workers you spawned, their live status, branch position, and pending mail.",
    parameters: z.object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const { root, repoRoot, self } = await requireSelf(pi, ctx.cwd);
      const roster = loadRoster(root);
      const children = roster.filter((r) => r.parent === self.handle);
      if (children.length === 0) {
        return { content: [{ type: "text", text: "No workers. Use foreman_spawn to create one." }], details: { children: [] } };
      }

      let agents: Array<{ cwd: string; status: string }> = [];
      if (process.env.HERDR_ENV) {
        try {
          agents = readAgentList(await herdrJson(pi, ["agent", "list"], repoRoot));
        } catch {
          agents = [];
        }
      }

      const rows: string[][] = [];
      const details: Array<Record<string, unknown>> = [];
      for (const child of children) {
        const status = process.env.HERDR_ENV ? agents.find((a) => a.cwd === child.cwd)?.status ?? "unknown" : "-";
        let ahead = "?";
        let behind = "?";
        // A git failure in one child's worktree renders that row's numbers
        // as "?" rather than failing the whole call.
        try {
          const counts = await run(pi, "git", ["rev-list", "--left-right", "--count", `${child.spawnSha}...HEAD`], child.cwd);
          const [behindOut, aheadOut] = counts.stdout.trim().split(/\s+/);
          behind = behindOut ?? "?";
          ahead = aheadOut ?? "?";
        } catch {
          // leave as "?"
        }
        let dirty = "?";
        try {
          const status2 = await run(pi, "git", ["status", "--porcelain"], child.cwd);
          dirty = String(status2.stdout.split("\n").filter((l) => l.trim().length > 0).length);
        } catch {
          // leave as "?"
        }
        const pending = pendingCount(root, child.handle);
        rows.push([child.handle, status, child.branch ?? "-", ahead, behind, dirty, String(pending)]);
        details.push({ handle: child.handle, status, branch: child.branch, ahead, behind, dirty, pending });
      }

      return {
        content: [{ type: "text", text: formatTable(["HANDLE", "STATUS", "BRANCH", "AHEAD", "BEHIND", "DIRTY", "PENDING"], rows) }],
        details: { children: details },
      };
    },
  });

  pi.registerTool({
    name: "foreman_reap",
    label: "Foreman Reap",
    description: "Remove a worker's worktree, branch pane, and roster entry. Refuses if it has uncommitted or unmerged work unless forced.",
    parameters: z.object({
      handle: z.string().describe("Worker to remove."),
      force: z.boolean().optional().describe("Remove even with uncommitted changes or unmerged commits. Destroys work."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { root, repoRoot, self } = await requireSelf(pi, ctx.cwd);
      const roster = loadRoster(root);
      const child = roster.find((r) => r.handle === params.handle);
      if (!child || child.parent !== self.handle) {
        throw new Error(`foreman: ${params.handle} is not a worker you spawned`);
      }
      if (!params.force) {
        const status = await run(pi, "git", ["status", "--porcelain"], child.cwd);
        const dirtyCount = status.stdout.split("\n").filter((l) => l.trim().length > 0).length;
        if (dirtyCount > 0) {
          throw new Error(`foreman: ${params.handle} has ${dirtyCount} uncommitted change(s). Commit them, or pass force=true to destroy them.`);
        }
        const ahead = await run(pi, "git", ["rev-list", `${child.spawnSha}..HEAD`, "--count"], child.cwd);
        const aheadCount = Number(ahead.stdout.trim());
        if (aheadCount > 0) {
          throw new Error(
            `foreman: ${params.handle} has ${aheadCount} commit(s) not in ${child.spawnSha}. Merge the branch, or pass force=true to discard them.`,
          );
        }
      }
      // Removal must go through herdr because creation did: `git worktree
      // remove` would delete the checkout and orphan the workspace, leaving
      // a sidebar entry pointing at nothing.
      const removeArgs = ["worktree", "remove", "--workspace", child.workspaceId ?? ""];
      if (params.force) removeArgs.push("--force");
      await run(pi, "herdr", removeArgs, repoRoot);
      rmSync(join(root, "roster", `${params.handle}.json`), { force: true });
      rmSync(join(root, "mail", params.handle), { recursive: true, force: true });
      rmSync(join(root, "done", params.handle), { recursive: true, force: true });
      return { content: [{ type: "text", text: `Reaped @${params.handle}: worktree removed, roster entry deleted.` }], details: {} };
    },
  });
}
