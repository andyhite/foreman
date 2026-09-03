/**
 * The rule engine `foreman plan`/`foreman build` share (simplification plan
 * Phase 4). A `Loop` fetches one snapshot of Linear-derived state per poll
 * and evaluates its `Rule`s in order; each rule's `Candidate`s are offered to
 * the dispatcher, gated by concurrency, prior failures, and confirmation.
 *
 * `runLoop` never writes to Linear itself — only `dispatch()`, which starts
 * an agent session that reaches Linear through the plugin's own write path.
 * The loop's only state is `InflightStore`, and losing it costs at most a
 * redundant dispatch.
 */

import { branchNameFor, priorityRank, type Confirmer, type Dispatcher, type DispatchRequest, type GitHubClient, type GlobalConfig, type Issue, type LinearWriter, type ResolvedRepoEntry } from "@foreman/core";
import nodeProcess from "node:process";
import { isDispatcherBusy } from "./dispatch/index.ts";
import { applyEscalation, type Escalation } from "./escalate.ts";
import type { InflightStore } from "./inflight.ts";

export type { Escalation } from "./escalate.ts";

export interface Rule<S> {
  name: string;
  select(snapshot: S): Candidate[];
}

export interface Candidate {
  /** "issue:PLT-12" | "project:<uuid>" | "triage:<first-id>" — stable across polls for the same unit of work, so `InflightStore` can dedupe it. */
  key: string;
  agent: string;
  command: string;
  subject: string;
  cwd: string;
  worktree: string | null;
  reason: string;
}

/** Highest priority first, then oldest first — the tie-break every rule's candidate list shares. */
export function byPriorityThenAge(a: Issue, b: Issue): number {
  const rankDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (rankDiff !== 0) return rankDiff;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

export interface Loop<S> {
  name: "plan" | "build";
  concurrency: number;
  fetch(ctx: LoopContext): Promise<S>;
  rules: Rule<S>[];
  /** Units of work this loop refuses to dispatch again; `runLoop` writes each to Linear before offering candidates (SPEC §17.7). */
  escalations?(snapshot: S, ctx: LoopContext): Escalation[];
}

export interface LoopContext {
  linear: LinearWriter;
  github: GitHubClient;
  entry: ResolvedRepoEntry;
  config: GlobalConfig;
  now: () => Date;
}

export type Logger = (message: string) => void;
/**
 * `candidate.worktree` is only a path (per `Candidate`'s own shape); the
 * `DispatchItem.worktree` a print/herdr dispatch needs also carries `branch`
 * and `baseBranch`, which require the issue's title (for a `<slug>`
 * branch-pattern token) that a `Candidate` does not carry. Rather than widen
 * `Candidate` or add a side-channel map keyed by `candidate.key`, `runLoop`
 * re-fetches the issue by identifier here — one extra Linear read per
 * worktree dispatch, paid only when a rule actually proposes one.
 */
async function resolveWorktree(
  candidate: Candidate,
  ctx: LoopContext,
): Promise<{ path: string; branch: string; baseBranch: string } | null> {
  if (candidate.worktree === null) return null;
  const issue = await ctx.linear.issue(candidate.subject);
  if (!issue) throw new Error(`${candidate.subject}: cannot resolve a worktree — Linear returned no issue for the identifier.`);
  return {
    path: candidate.worktree,
    branch: branchNameFor(ctx.entry.branchPattern, issue, ctx.entry.repoPath),
    baseBranch: ctx.entry.baseBranch,
  };
}

async function buildRequest(candidate: Candidate, ctx: LoopContext): Promise<DispatchRequest> {
  const worktree = await resolveWorktree(candidate, ctx);
  return {
    agent: candidate.agent,
    command: candidate.command,
    cwd: candidate.cwd,
    alias: ctx.entry.alias,
    items: [
      {
        issueId: candidate.key.startsWith("issue:") ? candidate.subject : null,
        subject: candidate.subject,
        dispatchId: `${candidate.key}-${ctx.now().getTime()}`,
        worktree,
      },
    ],
  };
}

export interface RunLoopOptions {
  once: boolean;
  dispatcher: Dispatcher;
  confirmer: Confirmer;
  state: InflightStore;
  log: Logger;
  pollMs: number;
}

/**
 * Offers every rule's candidates once, in rule order, respecting the
 * concurrency cap and prior-failure gate; each dispatched candidate's
 * `settle()` runs in the background so the caller can move on to the next
 * poll (or, in `--once` mode, be awaited at the end for a deterministic
 * exit). Returns the settle promises it started.
 */
async function offerCandidates<S>(
  loop: Loop<S>,
  snapshot: S,
  ctx: LoopContext,
  opts: RunLoopOptions,
  wake: () => void,
  gaveUpLogged: Set<string>,
): Promise<{ settling: Promise<void>[]; dispatched: number; candidates: number }> {
  const settling: Promise<void>[] = [];
  let dispatched = 0;
  let candidates = 0;
  for (const rule of loop.rules) {
    for (const candidate of rule.select(snapshot)) {
      candidates += 1;
      if (opts.state.has(candidate.key)) continue;
      if (opts.state.inFlightCount() >= loop.concurrency) continue;

      const cap = ctx.config.loop.retryCap;
      const failures = opts.state.failures(candidate.key);
      if (failures >= cap) {
        if (!gaveUpLogged.has(candidate.key)) {
          gaveUpLogged.add(candidate.key);
          if (candidate.key.startsWith("issue:")) {
            const summary = `escalate ${candidate.subject} (retry-exhausted)`;
            // eslint-disable-next-line no-await-in-loop -- confirmation and dispatch must serialize against the concurrency cap this same loop enforces.
            if (await opts.confirmer.confirm({ kind: "linear-write", summary })) {
              try {
                // eslint-disable-next-line no-await-in-loop
                opts.log(
                  await applyEscalation(ctx.linear, {
                    issueId: candidate.subject,
                    kind: "retry-exhausted",
                    attempts: failures,
                    detail: candidate.reason,
                  }),
                );
              } catch (error) {
                opts.log(`${summary}: failed (${error instanceof Error ? error.message : String(error)})`);
              }
            }
          } else {
            opts.log(`${candidate.key}: gave up after ${failures} failed dispatches; fix by hand.`);
          }
        }
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- confirmation and dispatch must serialize against the concurrency cap this same loop enforces.
      const approved = await opts.confirmer.confirm({ kind: `dispatch-${loop.name}`, summary: candidate.reason });
      if (!approved) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        const request = await buildRequest(candidate, ctx);
        // eslint-disable-next-line no-await-in-loop
        const handles = await opts.dispatcher.dispatch(request);
        const handle = handles[0];
        if (!handle) continue;
        opts.state.record(candidate.key, handle);
        dispatched += 1;

        const settled = opts.dispatcher
          .settle(handle)
          .then((outcome) => {
            if (outcome.status !== "settled" || outcome.exitCode !== 0) opts.state.recordFailure(candidate.key);
            else opts.state.clearFailures(candidate.key);
          })
          .catch((error: unknown) => {
            opts.log(`${candidate.key}: settle failed (${error instanceof Error ? error.message : String(error)})`);
            opts.state.recordFailure(candidate.key);
          })
          .finally(() => {
            opts.state.remove(candidate.key);
            if (!opts.once) wake();
          });
        settling.push(settled);
      } catch (error) {
        if (isDispatcherBusy(error)) {
          opts.log(`${candidate.key}: skipped, its workspace is busy`);
          continue;
        }
        opts.log(`${candidate.key}: dispatch failed (${error instanceof Error ? error.message : String(error)})`);
        opts.state.recordFailure(candidate.key);
      }
    }
  }
  return { settling, dispatched, candidates };
}

export async function runLoop<S>(loop: Loop<S>, ctx: LoopContext, opts: RunLoopOptions): Promise<void> {
  const gaveUpLogged = new Set<string>();
  let stop = false;
  const signalHandler = (): void => {
    stop = true;
  };
  // Bun's bundled `Process` type declares `once`/`removeListener` only
  // against a `"memoryPressure"` overload, dropping Node's `NodeJS.Signals`
  // overload; `signals` is `process` narrowed to the plain
  // `NodeJS.EventEmitter` surface Node itself guarantees it implements.
  const signals: NodeJS.EventEmitter = nodeProcess;
  signals.once("SIGINT", signalHandler);
  signals.once("SIGTERM", signalHandler);

  try {
    let wakeResolve: (() => void) | null = null;
    const wake = (): void => {
      wakeResolve?.();
    };

    for (;;) {
      let snapshot: S;
      try {
        snapshot = await loop.fetch(ctx);
      } catch (error) {
        if (opts.once) throw error;
        opts.log(`fetch failed, retrying next poll: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise<void>((res) => setTimeout(res, opts.pollMs));
        if (stop) return;
        continue;
      }

      for (const escalation of loop.escalations?.(snapshot, ctx) ?? []) {
        const summary = `escalate ${escalation.issueId} (${escalation.kind})`;
        // eslint-disable-next-line no-await-in-loop
        if (!(await opts.confirmer.confirm({ kind: "linear-write", summary }))) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          opts.log(await applyEscalation(ctx.linear, escalation));
        } catch (error) {
          opts.log(`${summary}: failed (${error instanceof Error ? error.message : String(error)})`);
        }
      }

      const { settling, dispatched, candidates } = await offerCandidates(loop, snapshot, ctx, opts, wake, gaveUpLogged);
      opts.log(`${loop.name}: ${dispatched} dispatched, ${opts.state.inFlightCount()} in flight, ${candidates} eligible`);

      if (opts.once) {
        await Promise.all(settling);
        return;
      }

      if (stop) {
        await Promise.all(settling);
        return;
      }

      const { promise: wakePromise, resolve } = Promise.withResolvers<void>();
      wakeResolve = resolve;
      await Promise.race([
        wakePromise,
        new Promise<void>((res) => setTimeout(res, opts.pollMs)),
      ]);
      wakeResolve = null;

      if (stop) {
        return;
      }
    }
  } finally {
    signals.removeListener("SIGINT", signalHandler);
    signals.removeListener("SIGTERM", signalHandler);
  }
}
