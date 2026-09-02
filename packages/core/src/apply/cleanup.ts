/**
 * Post-merge housekeeping (SPEC §12): once a merge is confirmed and the issue
 * has moved to Done, its worktree and whatever terminal state a dispatcher
 * held for it are done being used. Best-effort and silent on success — a
 * cleanup miss must never block or reverse the Linear transition that
 * already landed, so every failure comes back as a note for the caller to
 * log rather than an exception.
 */
import { existsSync } from "node:fs";
import type { CommandRunner } from "../git/exec.ts";
import { nodeRunner } from "../git/exec.ts";
import { removeWorktree, worktreePathFor, worktreeStatus } from "../git/worktree.ts";
import type { Dispatcher } from "../dispatch/types.ts";

export interface CleanupMergedWorkInput {
  repoPath: string;
  worktreePattern: string;
  baseBranch: string;
  issue: { identifier: string; title?: string };
  /** Omitted for callers with no live dispatcher (e.g. an operator-invoked command) — the tab/pane step is then skipped entirely. */
  dispatcher?: Dispatcher;
  runner?: CommandRunner;
}

/** Removes the issue's worktree when it exists and is clean, and closes its dispatcher tab/pane when a dispatcher is given. */
export async function cleanupMergedWork(input: CleanupMergedWorkInput): Promise<string[]> {
  const runner = input.runner ?? nodeRunner;
  const notes: string[] = [];
  const worktreePath = worktreePathFor(input.worktreePattern, input.repoPath, input.issue);

  if (existsSync(worktreePath)) {
    try {
      const status = await worktreeStatus(worktreePath, input.baseBranch, runner);
      if (status.dirty) {
        notes.push(`left ${input.issue.identifier}'s worktree (${worktreePath}) in place — it has uncommitted changes.`);
      } else {
        await removeWorktree(input.repoPath, worktreePath, runner);
      }
    } catch (error) {
      notes.push(`failed to remove ${input.issue.identifier}'s worktree (${worktreePath}): ${String(error)}`);
    }
  }

  if (input.dispatcher?.cleanup) {
    try {
      await input.dispatcher.cleanup(input.issue.identifier, input.repoPath, worktreePath);
    } catch (error) {
      notes.push(`failed to close ${input.issue.identifier}'s dispatcher tab: ${String(error)}`);
    }
  }

  return notes;
}
