/**
 * The board's one write path (SPEC §17.4: "The board is a view, not a control
 * plane"). Every mutation a screen wants to make is expressed as the same
 * slash command the operator would type, shelled through `omp -p` — never a
 * direct Linear write. This mirrors the loop's `PrintDispatcher` (§17.2) so
 * manual, board-driven, and loop-driven writes all go through one code path.
 *
 * `/foreman:unblock` and `/foreman:apply` are the omp-plugin commands this
 * module invokes (namespaced `/foreman:<file-stem>`, SPEC §16 assumption 3).
 * `/foreman:apply` is the whole proposal-resolution surface, four shapes:
 * bulk plan (no args, mutates nothing), bulk execute (`--yes`), per-item
 * approve (`<ISSUE-ID> --approve`), per-item reject (`<ISSUE-ID> --reject
 * <reason>`). The board only ever uses the last two.
 */

import type { GlobalConfig } from "@foreman/core";

/** The slice of `child_process` this module actually calls — the test seam. */
export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (bin: string, args: string[]) => Promise<CommandOutput>;

export async function defaultRunCommand(bin: string, args: string[]): Promise<CommandOutput> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export interface ActionsOptions {
  config: GlobalConfig;
  runCommand?: RunCommand;
}

export interface ActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs one omp print-mode command: `omp -p --approval-mode <mode> '<prompt>'`.
 * The approval mode is passed explicitly (SPEC §17.2, §17.3) — the print-mode
 * parent session is a second interrupt surface and stalls headless at
 * defaults, exactly like every other Foreman-dispatched parent.
 */
async function runPrintCommand(options: ActionsOptions, prompt: string): Promise<ActionResult> {
  const run = options.runCommand ?? defaultRunCommand;
  const { exitCode, stdout, stderr } = await run(options.config.agent.ompBin, [
    "-p",
    "--approval-mode",
    options.config.agent.approvalMode,
    prompt,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

/**
 * Resolves a `BlockRecord` by replying and clearing the block: the board's
 * highest-value action (SPEC §17.4). `reply` is either the label of a chosen
 * enumerated option or free text the operator typed.
 */
export function resolveBlock(
  options: ActionsOptions,
  issueId: string,
  reply: string,
): Promise<ActionResult> {
  return runPrintCommand(options, `/foreman:unblock ${issueId} ${reply}`);
}

/**
 * Approves one triage proposal item: `/foreman:apply <ISSUE-ID> --approve`
 * removes `agent:proposed` and applies that item. Canonical command shape
 * confirmed against the Extension implementation (SPEC §7.1's four-shape
 * `/foreman:apply` surface: bulk plan, bulk `--yes`, per-item `--approve`,
 * per-item `--reject <reason>`).
 */
export function acceptProposal(options: ActionsOptions, issueId: string): Promise<ActionResult> {
  return runPrintCommand(options, `/foreman:apply ${issueId} --approve`);
}

/**
 * Rejects one triage proposal item: `/foreman:apply <ISSUE-ID> --reject
 * <reason>` writes the `reject: <reason>` reply and leaves `agent:proposed`
 * in place, per the same four-shape `/foreman:apply` surface.
 */
export function rejectProposal(
  options: ActionsOptions,
  issueId: string,
  reason: string,
): Promise<ActionResult> {
  return runPrintCommand(options, `/foreman:apply ${issueId} --reject ${reason}`);
}
