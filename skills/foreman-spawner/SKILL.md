---
name: foreman-spawner
description: Use when dispatching work through foreman as the spawner/parent — calling foreman_spawn to create a peer coding agent in a fresh git worktree and branch, foreman_send to give a spawned worker a new task or follow-up, foreman_wait to block until a worker reports, foreman_ls to check on workers, or foreman_reap to remove one after its branch merges. Also use when a spawned worker interrupts you with foreman_ask and you need to judge whether to answer now. Trigger phrases: "split this across workers", "spawn an agent for X", "dispatch to a worktree", "act as foreman/dispatcher/boss".
---

Foreman spans two seats on one spawn edge: whoever calls `foreman_spawn` is
the parent, the session it creates is the child. This skill covers the
parent seat. A session can be a parent on one edge and a child on another at
the same time. Tool parameters are documented on the tools themselves; this
skill covers the judgement the parameters don't encode.

## Writing a brief a worker can act on

A spawned worker starts with no conversation history — the brief passed to
`foreman_spawn` is the entire context it has. Cold-start it the way you would
brief someone joining mid-project with no chat log to scroll:

- Name the exact files, symbols, and directories in scope, and say what's
  explicitly out of scope. A worker that has to guess scope will guess wrong
  in one direction or the other.
- State the acceptance criteria as an observable result, not a process. "The
  new endpoint returns 404 for an unknown id" is checkable; "handle the error
  case" is not.
- Give it any interface or schema it must conform to if its output feeds
  another worker's input. Decide that contract before spawning both — don't
  make two workers negotiate a shared interface over `foreman_ask`.
- Tell it to skip project-wide validation (full test suite, formatters) if
  other workers are touching the repo concurrently; running those mid-flight
  just blocks everyone on everyone else. Validate once, at integration.
- Name any skill or procedure the worker needs by its `skill://` URL. Foreman
  ships no execution skills of its own — a worker only reads what you tell
  it to, or what it infers from the repo.

## Judging an incoming `foreman_ask`

`foreman_ask` interrupts — it aborts your in-flight tool call and delivers
immediately, and the worker that sent it is now blocked inside its own tool
call waiting on you. Answer it directly and promptly; a `foreman_send` reply
resumes that worker mid-turn, where five minutes of silence costs it a whole
turn instead. That promptness is the entire point of the interrupt path. If
the same ambiguity is likely to recur across other workers, fold the answer
into future briefs instead of waiting for each one to ask.

## Waiting for reports

When you've dispatched everything you can and have nothing useful to do
until a worker reports, call `foreman_wait` rather than spinning on
`foreman_ls` — `foreman_ls` only tells you a worker is still running, never
what it found. `foreman_wait` blocks and hands you the next mail that lands,
whoever sent it, so check the sender before assuming it answered the thing
you had in mind. It gives up after five minutes and tells you to end your
turn; anything that lands later wakes you the ordinary way.

## One worker per branch

`foreman_spawn` ties a worker to one worktree and one branch for its whole
life. Don't reuse a worker's branch for unrelated work, and don't spawn a
second worker onto a branch another worker already owns — two agents
editing the same worktree race each other with no coordination primitive
between them. If work genuinely depends on another worker's in-flight
change, either wait for its report or take the dependency inline yourself
before spawning; don't have two workers on one branch renegotiate the same
files.

## Reap only after merging

`foreman_reap` refuses a worktree with uncommitted changes, and refuses one
whose branch has unmerged commits ahead of its spawn point, unless forced.
Treat both refusals as the intended outcome, not an obstacle: they are the
system's only checkpoint against silently discarding a worker's work. Force
a reap only when the branch's commits are genuinely disposable — an
abandoned approach, duplicated by another worker's branch — never as a
shortcut past a review you haven't done yet. Reap promptly once merged;
worktrees left around after their branch lands are just dead weight in
`foreman_ls`.

## Never touch git worktrees directly

Never run `git worktree` commands directly against a worker's checkout —
creation and removal both go through herdr (`herdr worktree create` /
`herdr worktree remove`), which also runs `tdi.worktree-setup` and keeps the
pane and sidebar entry in sync. A bare `git worktree remove` deletes the
checkout but orphans the herdr workspace; a bare `git worktree add` skips
setup entirely. Use `foreman_spawn`/`foreman_reap`, which already call
herdr for you — see `rule://herdr-worktrees`.
