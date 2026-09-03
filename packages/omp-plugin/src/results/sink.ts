/**
 * Structured-output capture (SPEC contract item 3, §3.5 item 5).
 *
 * A `foreman-*` agent's final `ParsedOutput` reaches the parent on exactly
 * one channel: the `tool_result` for `toolName === "task"`, whose
 * `result.details.results[]` entries are `SingleResult`s carrying a
 * `structuredOutput` field. That is the only payload omp ever populates with
 * structured data — measured, not assumed (docs/VERIFIED.md):
 *
 * - `task:subagent:lifecycle`/`:progress`/`:event` payloads are status only
 *   (`{ id, agent, parentToolCallId, detached, agentSource, description,
 *   status, sessionFile, index }`) — no task text, no `structuredOutput`.
 * - A background (non-`blocking`) spawn's settled result is delivered as an
 *   `async-result` custom message whose `details` is `{ jobs: [{ jobId,
 *   type, label, durationMs }] }` — prose content, no structured data.
 *
 * Both consequences are load-bearing: every Foreman agent declares
 * `blocking: true` so its `SingleResult` lands in the `tool_result` this
 * module reads, and no second channel can be listened on to compensate.
 *
 * Idempotency (a `foreman:applied` marker keyed on dispatch id) still guards
 * the one channel: a redelivery of the same yield is a no-op, not a double
 * mutation.
 */

import { lastMarkerValue } from "../enforce/task-guard.ts";
import { isRecord, isStructuredOutput } from "../util/guards.ts";

/** What every channel is normalized down to before `apply` sees it. */
export interface CapturedOutput {
  dispatchId: string;
  agent: string;
  data: unknown;
  /** The `SingleResult`-reported abort flag (SPEC §17.8) — set when the dispatch hit its budget mid-run rather than yielding cleanly. */
  aborted: boolean;
  /** The `FOREMAN-ISSUE` identifier embedded in the dispatched task text, or null when it could not be recovered — the issue the dispatch's lock was taken against (SPEC §3.5 item 5). */
  issueId: string | null;
  /** The `FOREMAN-PREV-STATE` workflow state id embedded in the dispatched task text, or null when absent (refine/review dispatches never move state, or the marker predates this field) — read back to restore the issue on an invalid result (Step 5 item 1). */
  previousStateId: string | null;
}
/** Recovers `dispatchId`/`issueId`/`previousStateId` from the `FOREMAN-*` marker lines embedded in the dispatched task text. */
export function extractDispatchInfo(
  taskText: string,
): { dispatchId: string | null; issueId: string | null; previousStateId: string | null } {
  const dispatchId = lastMarkerValue(/^FOREMAN-DISPATCH:\s*(\S+)\s*$/gm, taskText);
  const issueId = lastMarkerValue(/^FOREMAN-ISSUE:\s*(\S+)\s*$/gm, taskText);
  const previousStateId = lastMarkerValue(/^FOREMAN-PREV-STATE:\s*(\S+)\s*$/gm, taskText);
  return { dispatchId, issueId, previousStateId };
}

function taskTextOf(entry: unknown): string {
  if (!isRecord(entry)) return "";
  return typeof entry.task === "string" ? entry.task : "";
}

function agentOf(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  return typeof entry.agent === "string" ? entry.agent : null;
}

/** Reads the `aborted` flag off a `SingleResult`, defaulting to false when absent. */
function abortedOf(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return entry.aborted === true;
}

/**
 * Extracts every `CapturedOutput` from a `tool_result` event:
 * `{ toolName: "task", input: { tasks: [{ agent, task }] }, details: { results: [{ structuredOutput }] } }`.
 * Also tolerates the flat single-spawn `task` shape, where `input` itself is the one task entry.
 *
 * `details` sits flat on the event - measured, not assumed (docs/VERIFIED.md).
 * Reading it through an enclosing `result` field, which the runtime does not
 * emit, silently captured nothing for every stage.
 */
export function extractFromToolResult(payload: unknown): CapturedOutput[] {
  if (!isRecord(payload) || payload.toolName !== "task") return [];

  const input = isRecord(payload.input) ? payload.input : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : "task" in input ? [input] : [];

  const details = isRecord(payload.details) ? payload.details : {};
  const results = Array.isArray(details.results) ? details.results : [];

  const captured: CapturedOutput[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const single = results[index];
    if (!isRecord(single)) continue;
    const structuredOutput = single.structuredOutput;
    // A `status` of `invalid` is not dropped here: a budget-truncated yield
    // is both aborted and schema-invalid, and only `parseAgentOutput`
    // (downstream, in the extension) can tell that apart from a genuine
    // malformed result. `isStructuredOutput` remains the shape gate.
    if (!isStructuredOutput(structuredOutput)) continue;

    const agent = agentOf(tasks[index]);
    const { dispatchId, issueId, previousStateId } = extractDispatchInfo(taskTextOf(tasks[index]));
    if (!agent || !dispatchId) continue;

    captured.push({
      dispatchId,
      agent,
      data: structuredOutput.data,
      aborted: abortedOf(single),
      issueId,
      previousStateId,
    });
  }
  return captured;
}

/** Marks a dispatch as applied, and checks whether it already was. Backed by Linear markers (`results/apply.ts` writes them). */
export interface AppliedTracker {
  /** `agent` lets a plan/roadmap/triage dispatch id — whose encoded "subject" is a project id, initiative id, or the literal `"batch"`, never an issue id — skip the issue-scoped marker lookup entirely rather than querying Linear with a non-issue id. */
  wasApplied(dispatchId: string, agent: string): Promise<boolean>;
}

/**
 * Routes a captured output through `apply`, but only once per dispatch id.
 * The extension calls this for each captured `SingleResult`; a redelivery of
 * an already-applied dispatch id is silently dropped.
 */
export async function sink(
  captured: CapturedOutput,
  tracker: AppliedTracker,
  apply: (captured: CapturedOutput) => Promise<void>,
): Promise<void> {
  if (await tracker.wasApplied(captured.dispatchId, captured.agent)) return;
  await apply(captured);
}
