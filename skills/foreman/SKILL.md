---
name: foreman
description: Dispatch work to peer coding agents in git worktrees, and carry their reports and questions back. Use when the user wants work split across parallel branches, delegated to a worktree-isolated agent, or when acting as a dispatched worker needing to report back or ask a blocked question.
---

Foreman spans two seats on one spawn edge: whoever calls `foreman_spawn` is the
parent, the session it creates is the child. Every session carries the same
five tools (`foreman_spawn`, `foreman_send`, `foreman_ask`, `foreman_ls`,
`foreman_reap`) — there is no boss mode or worker mode to switch into, only
the edges you happen to sit on. Tool parameters are documented on the tools
themselves; this skill covers the judgement the parameters don't encode.

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

## When to ask versus decide

`foreman_ask` interrupts — it aborts the parent's in-flight tool call and
delivers immediately. `foreman_send` waits for the current run to finish.
That asymmetry is the whole rule: **only a stalled agent may interrupt.**
Calling `foreman_ask` ends your own turn, so by construction you've already
stopped working before you interrupt anyone else. Never send a routine
status update, a report, or an answer through `foreman_ask` — that path is
for driving directly into someone's live turn, and if you aren't stalled,
you don't need to.

So: ask when you cannot make forward progress without an answer — an
ambiguous requirement with materially different outcomes, a missing
credential, a conflict with another worker's in-flight edit. Decide
yourself, and note the choice in your report, when the ambiguity has a
reasonable default, or when getting it wrong is cheap to correct later.
Exhaust what you can infer from the repo (existing conventions, adjacent
code, the brief itself) before spending an interrupt on it.

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
