// Foreman: dispatch work to peer coding agents that each own a git worktree
// and a branch, and carry their reports and questions back — plus standing
// "expert" agents convened into a shared checkout for advisory/coordination
// roles that never own a branch, configurable per repo. Eight tools,
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

// "worker" owns a worktree and branch for its whole life (`foreman_spawn`).
// "expert" is a standing, branchless role convened into the spawner's own
// checkout (`foreman_convene`) — no worktree to be dirty or merge, so it
// skips every git-based lifecycle check a worker gets.
export type RosterKind = "worker" | "expert";

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
  kind: RosterKind;
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

// A session's git common dir and toplevel cannot change while the process
// lives, so this resolves once rather than on every drain and every tool
// call — feeding the old 250 ms poll cost eight `git rev-parse` subprocesses
// a second per worker, mail or no mail. Keyed by cwd because `ctx.cwd` is
// supplied per call; only successes are cached, so a `git init` mid-session
// still takes effect.
const factsCache = new Map<string, RepoFacts>();

export async function gitFacts(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<RepoFacts | null> {
  const cached = factsCache.get(cwd);
  if (cached) return cached;
  try {
    const key = await run(pi, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const root = await run(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
    const facts: RepoFacts = { repoKey: key.stdout.trim(), repoRoot: root.stdout.trim() };
    factsCache.set(cwd, facts);
    return facts;
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

// `kind` is read as `RosterEntry` before validation, so an old roster file
// written before "expert" existed reads back as `undefined`, not a runtime
// error — default it to "worker" so pre-convene rosters keep working.
function readRosterEntry(path: string): RosterEntry {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRosterEntry(parsed)) throw new Error(`foreman: corrupt roster entry at ${path}`);
  return { ...parsed, kind: parsed.kind === "expert" ? "expert" : "worker" };
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
//
// `paneId` disambiguates: one worker per worktree makes `cwd` a unique key
// by construction, but `foreman_convene` puts several experts in the same
// shared checkout, so two roster entries can share a `cwd`. Every herdr-
// managed pane gets its own `HERDR_PANE_ID` from herdr itself, so it is the
// tiebreaker; with a single candidate for `cwd` (the pre-convene case, and
// the one session nobody spawned) `paneId` is irrelevant and matching falls
// back to `cwd` alone, unchanged from before experts existed.
export function resolveSelf(root: string, repoRoot: string, paneId: string | null): RosterEntry {
  const roster = loadRoster(root);
  const candidates = roster.filter((r) => r.cwd === repoRoot);
  const existing = (paneId ? candidates.find((r) => r.paneId === paneId) : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
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
    paneId,
    kind: "worker",
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

// Reminder appended to every rendered message, not just the initial brief:
// briefs are common casualties of context compaction, so a worker several
// turns in may no longer have `skill://foreman-worker` in context at all.
// Direction is derived structurally from `self.parent`, not from message
// kind, because `canSend` only ever allows parent<->child edges: if the
// sender is self's own parent, self is acting as the child on this edge —
// worker or expert, depending on how it was spawned; otherwise the sender
// can only be a child self spawned, so self is acting as the spawner.
function skillReminder(msg: Message, self: RosterEntry): string {
  const childSkill = self.kind === "expert" ? "foreman-expert" : "foreman-worker";
  const skill = msg.from === self.parent ? childSkill : "foreman-spawner";
  return `[foreman] Re-read skill://${skill} now if it's not fresh in this context — it covers judgement these tool parameters don't encode.`;
}

function renderMessage(msg: Message, self: RosterEntry): string {
  const reminder = skillReminder(msg, self);
  if (msg.kind === "brief") {
    // An expert owns no branch or worktree — it shares the spawner's own
    // checkout — so "Branch: null" would read as a broken worker rather
    // than the intended standing role.
    const identity =
      self.kind === "expert"
        ? `You are @${self.handle}, a standing expert with no branch of your own. Working directory: ${self.cwd}.`
        : `You are worker @${self.handle}.\nBranch: ${self.branch}\nWorktree: ${self.cwd}`;
    return `[foreman:${msg.from}] ${identity}

${msg.text}

${reminder}`;
  }
  if (msg.kind === "ask") {
    return `[foreman:${msg.from}] BLOCKED

${msg.text}

${reminder}`;
  }
  return `[foreman:${msg.from}]

${msg.text}

${reminder}`;
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

// One slot, because two blocked waiters would split a single batch of mail
// between them. Held by `waitForMail`, cleared by whichever of mail, timeout,
// or abort arrives first.
let waiter: ((rendered: string) => void) | null = null;

export async function drainOnce(deps: DrainDeps): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const facts = await gitFacts(deps.pi, deps.cwd);
    if (!facts) return;
    const root = stateRoot(facts.repoKey);
    const self = resolveSelf(root, facts.repoRoot, process.env.HERDR_PANE_ID ?? null);
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

    const rendered = renderInbox(msgs, self);
    // A blocked `foreman_wait`/`foreman_ask` takes delivery instead of the
    // injection path: that caller has already stopped and is about to read
    // this batch as its tool result, so injecting a turn as well would
    // deliver the same messages twice.
    const takeDelivery = waiter;
    if (takeDelivery) {
      waiter = null;
      takeDelivery(rendered);
    } else {
      await deps.pi.sendMessage(
        {
          customType: INBOX_CUSTOM_TYPE,
          content: rendered,
          display: true,
          attribution: "user",
        },
        deliveryOptions(urgencyKind(msgs)),
      );
    }
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
  return { root, repoRoot: facts.repoRoot, self: resolveSelf(root, facts.repoRoot, process.env.HERDR_PANE_ID ?? null) };
}

// Blocks the calling tool until mail lands, so a peer's reply can come back as
// a tool result instead of "end your turn and hope". Measured: an extension
// tool can hold a turn for 300 s without the harness cancelling it
// (docs/ARCHITECTURE.md §8), so the bound below is a domain choice, not a
// runtime limit.
export const DEFAULT_WAIT_MS = 300_000;

export async function waitForMail(
  deps: DrainDeps,
  ctx: ExtensionToolContext,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string | null> {
  if (waiter) throw new Error("foreman: this session is already blocked waiting for mail");
  const { promise: arrived, resolve } = Promise.withResolvers<string | null>();
  const deadline = Date.now() + timeoutMs;
  waiter = resolve;
  // Timeout and abort have to vacate the slot themselves, or the next batch of
  // mail would resolve a promise nobody awaits and never be injected.
  const timer = ctx.setInterval(() => {
    if (waiter !== resolve) {
      ctx.clearTimer(timer);
      return;
    }
    if (signal?.aborted || Date.now() >= deadline) {
      ctx.clearTimer(timer);
      waiter = null;
      resolve(null);
    }
  }, 250);
  // Mail that landed before this armed would otherwise sit until the next
  // watcher event, which may never come.
  void drainOnce(deps).catch(() => undefined);
  return arrived;
}

function sleep(ctx: ExtensionToolContext, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = ctx.setInterval(() => {
    ctx.clearTimer(timer);
    resolve();
  }, ms);
  return promise;
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

function readTabCreateResult(value: unknown): { tabId: string; rootPaneId: string } {
  if (
    value &&
    typeof value === "object" &&
    "tab" in value &&
    value.tab &&
    typeof value.tab === "object" &&
    "tab_id" in value.tab &&
    typeof value.tab.tab_id === "string" &&
    "root_pane" in value &&
    value.root_pane &&
    typeof value.root_pane === "object" &&
    "pane_id" in value.root_pane &&
    typeof value.root_pane.pane_id === "string"
  ) {
    return { tabId: value.tab.tab_id, rootPaneId: value.root_pane.pane_id };
  }
  throw new Error("foreman: herdr tab create returned an unexpected shape");
}

function readPaneSplitResult(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "pane" in value &&
    value.pane &&
    typeof value.pane === "object" &&
    "pane_id" in value.pane &&
    typeof value.pane.pane_id === "string"
  ) {
    return value.pane.pane_id;
  }
  throw new Error("foreman: herdr pane split returned an unexpected shape");
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

// Shared by `foreman_spawn` (one pane, no model override) and
// `foreman_convene` (N panes, one optional model override each) — the
// pane-not-ready-yet retry dance is identical either way, only the target
// pane and native args differ.
async function startAgentOnPane(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  repoRoot: string,
  handle: string,
  paneId: string,
  timeoutMs: number,
  model: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  const nativeArgs = model ? ["--", `--model=${model}`] : [];
  // `agent start` needs the pane at an interactive shell prompt, and a
  // brand-new pane is not — zsh, mise and direnv take seconds — so early
  // attempts fail fast. Retry against an absolute deadline, never
  // accumulated sleeps.
  while (Date.now() < deadline) {
    try {
      await run(
        pi,
        "herdr",
        ["agent", "start", handle, "--kind", "omp", "--pane", paneId, "--timeout", String(Math.max(0, deadline - Date.now())), ...nativeArgs],
        repoRoot,
      );
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // `start` reported failure, but it may have lost the race against its
      // own readiness poll rather than actually failed to launch — check
      // ground truth before sleeping and retrying, or we risk running
      // `agent start` a second time against an already-live pane.
      if (await agentLiveOnPane(pi, repoRoot, paneId)) return { ok: true };
      await sleep(ctx, 1000);
    }
  }
  if (await agentLiveOnPane(pi, repoRoot, paneId)) return { ok: true };
  return { ok: false, error: lastError };
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
// Role config. `.foreman/roles.json` in the repo (committed, shared by the
// team) maps a short role name to a reusable definition, so a `foreman_spawn`
// or `foreman_convene` call can say `role: "pm"` instead of retyping the same
// brief and skill list every time. `description` is never sent to the
// spawned worker or expert — it exists purely for `foreman_roles` to show
// the orchestrating agent, which never sees the child's own brief, when a
// request should defer to that role instead of being handled inline.
// ---------------------------------------------------------------------

export interface RoleDefinition {
  description: string;
  brief: string;
  skills: string[];
  model: string | null;
}

export function loadRoleConfig(repoRoot: string): Record<string, RoleDefinition> {
  const path = process.env.FOREMAN_ROLES_FILE || join(repoRoot, ".foreman", "roles.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`foreman: ${path} is not valid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`foreman: ${path} must be a JSON object mapping role name to definition`);
  }
  const roles: Record<string, RoleDefinition> = {};
  for (const [name, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`foreman: role "${name}" in ${path} must be an object`);
    }
    const description = "description" in raw ? raw.description : undefined;
    const brief = "brief" in raw ? raw.brief : undefined;
    const skills = "skills" in raw ? raw.skills : undefined;
    const model = "model" in raw ? raw.model : undefined;
    if (typeof description !== "string" || typeof brief !== "string") {
      throw new Error(`foreman: role "${name}" in ${path} needs a "description" and "brief" string`);
    }
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== "string"))) {
      throw new Error(`foreman: role "${name}" in ${path} has a non-string "skills" array`);
    }
    if (model !== undefined && model !== null && typeof model !== "string") {
      throw new Error(`foreman: role "${name}" in ${path} has a non-string "model"`);
    }
    roles[name] = { description, brief, skills: (skills as string[] | undefined) ?? [], model: (model as string | null | undefined) ?? null };
  }
  return roles;
}

export interface BriefRequest {
  handle: string;
  role?: string;
  brief?: string;
  skills?: string[];
  model?: string;
}

// Resolves one `foreman_spawn` or `foreman_convene` entry against the loaded
// role config: `model` is a scalar override, `skills` and `brief` both
// compose instead — a per-call `skills` list is appended after the role's
// own, and a per-call `brief` is appended after the role's own rather than
// replacing it, the same way a spawner amends a standing charter with a
// task-specific addendum instead of overwriting it. The output text is the
// actual initial brief enqueued for the child — skills are threaded through
// as an explicit "load these" line so a role's whole skill set travels with
// it, rather than relying on prose in `brief` to name them.
export function resolveBrief(request: BriefRequest, roles: Record<string, RoleDefinition>): { text: string; model?: string } {
  const role = request.role ? roles[request.role] : undefined;
  if (request.role && !role) {
    const known = Object.keys(roles);
    throw new Error(
      `foreman: role "${request.role}" is not configured` +
        (known.length > 0 ? ` — known roles: ${known.join(", ")}` : " — .foreman/roles.json has no roles"),
    );
  }
  const brief = [role?.brief, request.brief].filter((b): b is string => Boolean(b)).join("\n\n");
  if (!brief) throw new Error(`foreman: "${request.handle}" needs a "brief", or a "role" that has one`);
  const skills = [...(role?.skills ?? []), ...(request.skills ?? [])];
  const model = request.model ?? role?.model ?? undefined;
  const text = skills.length > 0 ? `Load these skills, in order: ${skills.join(", ")}\n\n${brief}` : brief;
  return model ? { text, model } : { text };
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
      "Spawn a peer coding agent into a fresh git worktree and branch, and dispatch its first task. Requires herdr. See foreman_roles for roles this repo has pre-configured.",
    parameters: z.object({
      handle: z
        .string()
        .describe(
          "Short name for the worker: lowercase letters, digits, hyphens, underscores; must start with a letter. This is how you address it later.",
        ),
      branch: z.string().describe("Branch the worker will own. Created fresh from base."),
      base: z.string().optional().describe("Ref the branch starts from. Defaults to your checkout's current HEAD."),
      role: z
        .string()
        .optional()
        .describe("Name of a role from .foreman/roles.json (see foreman_roles). Supplies brief, skills, and model unless overridden below."),
      brief: z
        .string()
        .optional()
        .describe(
          "The complete task. The worker starts with no conversation history, so state the goal, the files, and what done looks like. Required unless `role` supplies one.",
        ),
      skills: z
        .array(z.string())
        .optional()
        .describe("skill:// URIs to load, in order. Appended after the role's own skills, if `role` is set."),
      model: z
        .string()
        .optional()
        .describe("Model override for this worker, fuzzy-matched by the omp CLI (e.g. \"opus\", \"gpt-5.2\"). Overrides the role's model."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!validHandle(params.handle)) {
        throw new Error(
          `foreman: invalid handle "${params.handle}" — use lowercase letters, digits, - or _, starting with a letter, max 32 chars`,
        );
      }
      const facts = await gitFacts(pi, ctx.cwd);
      if (!facts) throw new Error("foreman: not inside a git repository");
      const roles = loadRoleConfig(facts.repoRoot);
      // Resolved up front, before any herdr call, so an unknown role or a
      // missing brief fails before a worktree and branch are created for
      // foreman_reap to clean up.
      const resolved = resolveBrief(params, roles);
      const root = stateRoot(facts.repoKey);
      const rosterPath = join(root, "roster", `${params.handle}.json`);
      if (existsSync(rosterPath)) {
        const existing = readRosterEntry(rosterPath);
        throw new Error(`foreman: handle ${params.handle} is already taken by the worker on branch ${existing.branch}`);
      }
      if (process.env.HERDR_ENV !== "1") {
        throw new Error("foreman: requires herdr — worktree panes are how workers get a terminal. Start a herdr session first.");
      }

      const self = resolveSelf(root, facts.repoRoot, process.env.HERDR_PANE_ID ?? null);
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
        kind: "worker",
        createdAt: new Date().toISOString(),
      });

      // Before starting the agent, so the worker's first drain finds it.
      enqueue(root, { from: self.handle, to: params.handle, kind: "brief", text: resolved.text, sentAt: new Date().toISOString() });

      const timeoutMs = Number(process.env.FOREMAN_SPAWN_TIMEOUT_MS) || 60000;
      const result = await startAgentOnPane(pi, ctx, facts.repoRoot, params.handle, paneId, timeoutMs, resolved.model);
      if (!result.ok) {
        const seconds = Math.round(timeoutMs / 1000);
        throw new Error(
          `foreman: worktree and branch exist but no agent started within ${seconds}s. Last error: ${result.error}. Clean up with foreman_reap ${params.handle} force=true.`,
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
      "Ask your parent a question you cannot decide yourself, and block until they answer. The answer comes back as this tool's result, so you can carry straight on. Only worth spending an interrupt on a decision you genuinely cannot infer.",
    parameters: z.object({
      text: z.string().describe("The decision you need. Include everything needed to answer it without a follow-up."),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to block before giving up, in milliseconds. Defaults to 300000 (5 minutes)."),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const { root, self } = await requireSelf(pi, ctx.cwd);
      if (!self.parent) throw new Error("foreman: you have no parent to ask — nobody spawned this session");
      enqueue(root, { from: self.handle, to: self.parent, kind: "ask", text: params.text, sentAt: new Date().toISOString() });
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
      const rendered = await waitForMail({ pi, cwd: ctx.cwd }, ctx, signal, timeoutMs);
      if (rendered === null) {
        // Degrades to the old contract rather than failing: the question is
        // still queued, so ending the turn still gets an answer eventually.
        return {
          content: [
            {
              type: "text",
              text: `Question sent to @${self.parent}, but no answer within ${Math.round(timeoutMs / 1000)}s. End your turn — their answer will wake you as a new message when it comes.`,
            },
          ],
          details: { answered: false },
        };
      }
      return { content: [{ type: "text", text: rendered }], details: { answered: true } };
    },
  });

  pi.registerTool({
    name: "foreman_wait",
    label: "Foreman Wait",
    description:
      "Block until mail arrives and return it as this tool's result. Use it when you have nothing useful to do until a worker reports. Returns the next batch that lands, whoever sent it — check the sender and call again if it wasn't what you were waiting for.",
    parameters: z.object({
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to block before giving up, in milliseconds. Defaults to 300000 (5 minutes)."),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_MS;
      const rendered = await waitForMail({ pi, cwd: ctx.cwd }, ctx, signal, timeoutMs);
      if (rendered === null) {
        return {
          content: [
            {
              type: "text",
              text: `No mail within ${Math.round(timeoutMs / 1000)}s. End your turn — anything that lands later will wake you as a new message.`,
            },
          ],
          details: { delivered: false },
        };
      }
      return { content: [{ type: "text", text: rendered }], details: { delivered: true } };
    },
  });

  pi.registerTool({
    name: "foreman_ls",
    label: "Foreman List",
    description: "List the workers and experts you spawned or convened, their live status, branch position (workers) or pane (experts), and pending mail.",
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
        let ahead = "-";
        let behind = "-";
        let dirty = "-";
        // An expert shares the spawner's own checkout rather than owning a
        // worktree, so running git rev-list/status against child.cwd would
        // report the WHOLE repo's state under that one expert's row — wrong
        // attribution, not just noise. Skip the git calls entirely for
        // experts instead of coercing them into "?".
        if (child.kind === "worker") {
          ahead = "?";
          behind = "?";
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
          dirty = "?";
          try {
            const status2 = await run(pi, "git", ["status", "--porcelain"], child.cwd);
            dirty = String(status2.stdout.split("\n").filter((l) => l.trim().length > 0).length);
          } catch {
            // leave as "?"
          }
        }
        const pending = pendingCount(root, child.handle);
        rows.push([child.handle, child.kind, status, child.branch ?? "-", ahead, behind, dirty, String(pending)]);
        details.push({ handle: child.handle, kind: child.kind, status, branch: child.branch, ahead, behind, dirty, pending });
      }

      return {
        content: [
          { type: "text", text: formatTable(["HANDLE", "KIND", "STATUS", "BRANCH", "AHEAD", "BEHIND", "DIRTY", "PENDING"], rows) },
        ],
        details: { children: details },
      };
    },
  });

  pi.registerTool({
    name: "foreman_reap",
    label: "Foreman Reap",
    description:
      "Remove a worker's worktree, branch pane, and roster entry, or an expert's pane and roster entry. Refuses a worker with uncommitted or unmerged work unless forced.",
    parameters: z.object({
      handle: z.string().describe("Worker or expert to remove."),
      force: z.boolean().optional().describe("Remove even with uncommitted changes or unmerged commits. Destroys work. Ignored for experts."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { root, repoRoot, self } = await requireSelf(pi, ctx.cwd);
      const roster = loadRoster(root);
      const child = roster.find((r) => r.handle === params.handle);
      if (!child || child.parent !== self.handle) {
        throw new Error(`foreman: ${params.handle} is not a worker or expert you spawned`);
      }

      let resultText: string;
      if (child.kind === "expert") {
        // An expert owns no branch or worktree — it shares the spawner's
        // checkout — so there is nothing to guard against losing: closing
        // its pane discards no commits, unlike a worker's worktree removal.
        await run(pi, "herdr", ["pane", "close", child.paneId ?? ""], repoRoot);
        resultText = `Reaped @${params.handle}: pane closed, roster entry deleted.`;
      } else {
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
        resultText = `Reaped @${params.handle}: worktree removed, roster entry deleted.`;
      }

      rmSync(join(root, "roster", `${params.handle}.json`), { force: true });
      rmSync(join(root, "mail", params.handle), { recursive: true, force: true });
      rmSync(join(root, "done", params.handle), { recursive: true, force: true });
      return { content: [{ type: "text", text: resultText }], details: {} };
    },
  });

  pi.registerTool({
    name: "foreman_roles",
    label: "Foreman Roles",
    description:
      "List the roles configured in .foreman/roles.json for this repo, each with the description that says when to defer to it. Read this before foreman_spawn or foreman_convene, or whenever deciding whether a request belongs to a standing role instead of being handled inline.",
    parameters: z.object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const facts = await gitFacts(pi, ctx.cwd);
      if (!facts) throw new Error("foreman: not inside a git repository");
      const roles = loadRoleConfig(facts.repoRoot);
      const names = Object.keys(roles);
      if (names.length === 0) {
        return {
          content: [{ type: "text", text: "No roles configured. Add .foreman/roles.json to define reusable roles for foreman_spawn and foreman_convene." }],
          details: { roles: {} },
        };
      }
      const rows = names.map((name) => [name, roles[name].description, roles[name].skills.join(", ") || "-", roles[name].model ?? "-"]);
      const table = formatTable(["ROLE", "DESCRIPTION", "SKILLS", "MODEL"], rows);
      return { content: [{ type: "text", text: table }], details: { roles } };
    },
  });

  pi.registerTool({
    name: "foreman_convene",
    label: "Foreman Convene",
    description:
      "Convene a cluster of standing expert agents into a fresh herdr tab, one pane each, sharing your own checkout. Unlike foreman_spawn, experts own no branch or worktree — use this for advisory/coordination roles (product manager, release engineer, ...) you'll send repeated requests to, not one-shot units of code work. See foreman_roles for roles this repo has pre-configured.",
    parameters: z.object({
      label: z.string().optional().describe("Tab label. Defaults to \"foreman experts\"."),
      experts: z
        .array(
          z.object({
            handle: z
              .string()
              .describe(
                "Short name for the expert: lowercase letters, digits, hyphens, underscores; must start with a letter. This is how you address it later.",
              ),
            role: z
              .string()
              .optional()
              .describe("Name of a role from .foreman/roles.json (see foreman_roles). Supplies brief, skills, and model unless overridden below."),
            brief: z
              .string()
              .optional()
              .describe(
                "The expert's standing role: the domain it owns and how it should report back. It starts with no conversation history and stays available after replying, so this is the only briefing it gets. Required unless `role` supplies one.",
              ),
            skills: z
              .array(z.string())
              .optional()
              .describe("skill:// URIs to load, in order. Appended after the role's own skills, if `role` is set."),
            model: z
              .string()
              .optional()
              .describe("Model override for this expert, fuzzy-matched by the omp CLI (e.g. \"opus\", \"gpt-5.2\"). Overrides the role's model."),
          }),
        )
        .min(1)
        .describe("One entry per expert pane, created left-to-right/top-to-bottom in array order."),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const seen = new Set<string>();
      for (const expert of params.experts) {
        if (!validHandle(expert.handle)) {
          throw new Error(
            `foreman: invalid handle "${expert.handle}" — use lowercase letters, digits, - or _, starting with a letter, max 32 chars`,
          );
        }
        if (seen.has(expert.handle)) throw new Error(`foreman: duplicate handle "${expert.handle}" in this convene call`);
        seen.add(expert.handle);
      }
      const facts = await gitFacts(pi, ctx.cwd);
      if (!facts) throw new Error("foreman: not inside a git repository");
      const roles = loadRoleConfig(facts.repoRoot);
      // Resolved up front, before any herdr call, so an unknown role or a
      // missing brief fails the whole convene instead of leaving a partial
      // tab of panes behind for foreman_reap to clean up.
      const resolved = params.experts.map((expert) => resolveBrief(expert, roles));
      const root = stateRoot(facts.repoKey);
      for (const expert of params.experts) {
        const rosterPath = join(root, "roster", `${expert.handle}.json`);
        if (existsSync(rosterPath)) {
          const existing = readRosterEntry(rosterPath);
          throw new Error(`foreman: handle ${expert.handle} is already taken by the ${existing.kind} at ${existing.cwd}`);
        }
      }
      if (process.env.HERDR_ENV !== "1") {
        throw new Error("foreman: requires herdr — expert panes are how experts get a terminal. Start a herdr session first.");
      }
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!workspaceId) throw new Error("foreman: HERDR_WORKSPACE_ID is not set — run inside a herdr workspace.");

      const self = resolveSelf(root, facts.repoRoot, process.env.HERDR_PANE_ID ?? null);

      const tabCreated = await herdrJson(
        pi,
        ["tab", "create", "--workspace", workspaceId, "--cwd", facts.repoRoot, "--label", params.label ?? "foreman experts", "--no-focus"],
        facts.repoRoot,
      );
      const { tabId, rootPaneId } = readTabCreateResult(tabCreated);

      // Alternate split direction rather than always splitting the same way,
      // or N panes collapse into one unusably thin row (always-right) or
      // column (always-down).
      const paneIds: string[] = [rootPaneId];
      for (let i = 1; i < params.experts.length; i++) {
        const direction = i % 2 === 1 ? "right" : "down";
        const split = await herdrJson(
          pi,
          ["pane", "split", paneIds[paneIds.length - 1], "--direction", direction, "--cwd", facts.repoRoot, "--no-focus"],
          facts.repoRoot,
        );
        paneIds.push(readPaneSplitResult(split));
      }

      const timeoutMs = Number(process.env.FOREMAN_SPAWN_TIMEOUT_MS) || 60000;
      const results: Array<{ handle: string; paneId: string; started: boolean; error?: string }> = [];
      for (let i = 0; i < params.experts.length; i++) {
        const expert = params.experts[i];
        const paneId = paneIds[i];
        writeRosterEntry(root, {
          handle: expert.handle,
          parent: self.handle,
          // An expert shares the spawner's own checkout rather than a
          // dedicated worktree — there is no isolated unit of code work to
          // give it a branch for, only a standing advisory role.
          cwd: facts.repoRoot,
          branch: null,
          spawnSha: null,
          workspaceId,
          paneId,
          kind: "expert",
          createdAt: new Date().toISOString(),
        });
        // Before starting the agent, so the expert's first drain finds it.
        enqueue(root, { from: self.handle, to: expert.handle, kind: "brief", text: resolved[i].text, sentAt: new Date().toISOString() });
        const result = await startAgentOnPane(pi, ctx, facts.repoRoot, expert.handle, paneId, timeoutMs, resolved[i].model);
        results.push({ handle: expert.handle, paneId, started: result.ok, error: result.error });
      }

      const lines = results.map((r) =>
        r.started
          ? `@${r.handle} ready on pane ${r.paneId}`
          : `@${r.handle} FAILED to start on pane ${r.paneId} (${r.error}) — clean up with foreman_reap ${r.handle} force=true`,
      );
      return {
        content: [{ type: "text", text: `Convened tab ${tabId} with ${params.experts.length} expert(s):\n${lines.join("\n")}` }],
        details: { tabId, experts: results },
      };
    },
  });
}
