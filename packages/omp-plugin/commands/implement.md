---
description: Implement a refined, ready issue and open a PR
argument-hint: <ISSUE-ID>
---

<critical>
- Exactly ONE issue per invocation, ONE `tasks[]` entry. NEVER batch: each issue needs its own Foreman-managed worktree, and a non-isolated spawn inherits its parent's cwd.
- Task text MUST carry `FOREMAN-ISSUE: $1` on its own line; the extension keys the lock, worktree, and result capture on it.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the implementation procedure; `foreman-implement-issue` is autoloaded.
</critical>

## Resolve

`$1` via `foreman_linear_read` `op: "issue"` with `id: "$1"`: description,
acceptance criteria, estimate, labels, relations.

## Gate

Implementation gate MUST hold: refinement gate satisfied, issue in Ready,
unassigned or assigned only to the dispatching credential, no incomplete
`blocked by` relation. Fails → do not dispatch; tell the operator which
predicate failed.

## Dispatch

One `task` call, one `tasks[]` entry, `agent: foreman-implement`. Task text:
`FOREMAN-ISSUE: $1`, the issue's description, acceptance criteria, estimate,
and the two-layer `Context` digest (product `Context` doc + project brief,
Definition of Done included).

Before the spawn the extension claims the lock (an issue comment, not a
label), creates or reuses the worktree, moves the issue to In Progress, and
appends `FOREMAN-DISPATCH`, `FOREMAN-WORKTREE`, `FOREMAN-BRANCH`, and
`FOREMAN-BASE` lines to the task text. You add none of these yourself.

## After

`ImplementResult` → extension moves the issue to In Review, releases the
lock, files `discoveredWork` as Backlog issues. `BlockRecord` → extension
moves the issue to Needs Input and parks it. Nothing else changes state.
