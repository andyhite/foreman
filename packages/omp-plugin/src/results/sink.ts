/**
 * Multi-channel structured-output capture (SPEC contract item 3).
 *
 * A `foreman-*` agent's final `ParsedOutput` can arrive by three routes, and
 * only the first is documented: `tool_result` for `toolName === "task"`
 * carries `result.details.results[]`, each an optional `SingleResult` with a
 * `structuredOutput` field; `task:subagent:lifecycle` fires on the parent bus
 * with an undocumented payload; and a subagent's own `yield` tool call may
 * surface in the parent's `tool_call` interception. This module probes each
 * payload structurally rather than trusting a fabricated type, and funnels
 * every hit into one idempotent `apply`.
 *
 * Idempotency (a `foreman:applied` marker keyed on dispatch id) is what makes
 * listening on the unverified channels safe: a duplicate delivery from two
 * channels firing for the same yield is a no-op, not a double mutation.
 */

import { isRecord, isStructuredOutput } from "../util/guards.ts";

/** What every channel is normalized down to before `apply` sees it. */
export interface CapturedOutput {
  dispatchId: string;
  agent: string;
  data: unknown;
  /** The lifecycle-reported abort flag (SPEC §17.8) — set when the dispatch hit its budget mid-run rather than yielding cleanly. */
  aborted: boolean;
}

/** Recovers `agent`/`dispatchId` from the `FOREMAN-*` marker lines embedded in the dispatched task text. */
export function extractDispatchInfo(taskText: string): { agent: string | null; dispatchId: string | null } {
  const agentMatch = /^FOREMAN-AGENT:\s*(\S+)\s*$/m.exec(taskText);
  const dispatchMatch = /^FOREMAN-DISPATCH:\s*(\S+)\s*$/m.exec(taskText);
  return { agent: agentMatch?.[1] ?? null, dispatchId: dispatchMatch?.[1] ?? null };
}

function taskTextOf(entry: unknown): string {
  if (!isRecord(entry)) return "";
  return typeof entry.task === "string" ? entry.task : "";
}

function agentOf(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  return typeof entry.agent === "string" ? entry.agent : null;
}

/** Reads the lifecycle-reported `aborted` flag off a raw entry, defaulting to false when absent. */
function abortedOf(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return entry.aborted === true;
}

/**
 * Extracts every `CapturedOutput` from a `tool_result`-shaped payload:
 * `{ toolName: "task", input: { tasks: [{ agent, task }] }, result: { details: { results: [{ structuredOutput }] } } }`.
 * Also tolerates the flat single-spawn `task` shape, where `input` itself is the one task entry.
 */
export function extractFromToolResult(payload: unknown): CapturedOutput[] {
  if (!isRecord(payload) || payload.toolName !== "task") return [];

  const input = isRecord(payload.input) ? payload.input : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : "task" in input ? [input] : [];

  const result = isRecord(payload.result) ? payload.result : {};
  const details = isRecord(result.details) ? result.details : {};
  const results = Array.isArray(details.results) ? details.results : [];

  const captured: CapturedOutput[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const single = results[index];
    if (!isRecord(single)) continue;
    const structuredOutput = single.structuredOutput;
    if (!isStructuredOutput(structuredOutput) || !structuredOutput.valid) continue;

    const agent = agentOf(tasks[index]);
    const { dispatchId } = extractDispatchInfo(taskTextOf(tasks[index]));
    if (!agent || !dispatchId) continue;

    captured.push({ dispatchId, agent, data: structuredOutput.data, aborted: abortedOf(single) || abortedOf(payload.result) });
  }
  return captured;
}

/**
 * Extracts a `CapturedOutput` from an undocumented `task:subagent:lifecycle`
 * payload. Probed structurally: any object carrying `structuredOutput` (in
 * the same `{ data, valid }` shape) alongside a task-text field the
 * `FOREMAN-*` markers can be pulled from, or an explicit `dispatchId` field.
 */
export function extractFromLifecycle(payload: unknown): CapturedOutput | null {
  if (!isRecord(payload)) return null;
  const structuredOutput = payload.structuredOutput;
  if (!isStructuredOutput(structuredOutput) || !structuredOutput.valid) return null;

  const agent = typeof payload.agent === "string" ? payload.agent : null;
  const taskText =
    typeof payload.task === "string" ? payload.task : taskTextOf(payload.input);
  const { dispatchId } = extractDispatchInfo(taskText);
  const explicitDispatchId = typeof payload.dispatchId === "string" ? payload.dispatchId : null;
  const finalDispatchId = explicitDispatchId ?? dispatchId;
  if (!agent || !finalDispatchId) return null;

  return { dispatchId: finalDispatchId, agent, data: structuredOutput.data, aborted: abortedOf(payload) };
}

/** Marks a dispatch as applied, and checks whether it already was. Backed by Linear markers (`results/apply.ts` writes them). */
export interface AppliedTracker {
  wasApplied(dispatchId: string): Promise<boolean>;
}

/**
 * Routes a captured output through `apply`, but only once per dispatch id.
 * Consumers call this from every channel; a duplicate is silently dropped.
 */
export async function sink(
  captured: CapturedOutput,
  tracker: AppliedTracker,
  apply: (captured: CapturedOutput) => Promise<void>,
): Promise<void> {
  if (await tracker.wasApplied(captured.dispatchId)) return;
  await apply(captured);
}
