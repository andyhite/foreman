---
name: foreman-worker
description: Use when this session was spawned by another agent through foreman_spawn and is running inside a foreman-managed git worktree/branch — recognizable because the first message in the conversation is "[foreman:<handle>] You are worker @<handle>". Covers deciding when to interrupt your parent with foreman_ask versus deciding yourself and noting the call in your report, and how to report progress, ask a question, or hand off completed work with foreman_send.
---

Foreman spans two seats on one spawn edge: whoever calls `foreman_spawn` is
the parent, the session it creates is the child. This skill covers the
child seat — you. Tool parameters are documented on the tools themselves;
this skill covers the judgement the parameters don't encode.

## Stay on your branch

`foreman_spawn` tied you to one worktree and one branch for your whole life
as this worker. Work only inside your worktree; don't reach into another
worktree or branch, even one owned by a sibling worker you know about — two
agents editing the same checkout race each other with no coordination
primitive between them. If your task turns out to depend on another
worker's in-flight change, ask your parent (`foreman_ask`) or report the
blocker rather than editing that worker's files yourself.

## When to ask versus decide

`foreman_ask` interrupts — it aborts your parent's in-flight tool call and
delivers immediately. `foreman_send` (for routine updates) waits for your
parent's current run to finish. That asymmetry is the whole rule: **only a
stalled agent may interrupt.** Calling `foreman_ask` blocks you until the
answer arrives and then hands it back as the tool's own result, so by
construction you've stopped working before you interrupt your parent — and
you resume mid-turn with the answer in hand rather than ending your turn to
wait for it. Never send a routine status update or a report through
`foreman_ask` — that path is for driving directly into your parent's live
turn, and if you aren't stalled, you don't need to.

So: ask when you cannot make forward progress without an answer — an
ambiguous requirement with materially different outcomes, a missing
credential, a conflict with another worker's in-flight edit. Decide
yourself, and note the choice in your report, when the ambiguity has a
reasonable default, or when getting it wrong is cheap to correct later.
Exhaust what you can infer from the repo (existing conventions, adjacent
code, the brief itself) before spending an interrupt on it.

If nobody answers within five minutes the call returns saying so. That is a
normal outcome, not a failure: the question is still queued, so end your
turn and the answer will wake you when it comes.

## Reporting back

Your parent only sees what you send it — there's no shared scrollback.
Use `foreman_send` to your parent when you finish the task, when you hit a
milestone worth surfacing, or when you have a non-blocking observation
(e.g. a decision you made unilaterally). State what changed, where
(files/commits, not prose descriptions the parent has to re-derive), and
whether it's ready to merge. A report that just says "done" forces your
parent to go re-read your diff to find out what "done" means.

## Never touch git worktrees directly

Never run `git worktree` commands directly against your own checkout —
creation and removal both go through herdr (`herdr worktree create` /
`herdr worktree remove`) on your parent's side, which also runs
`tdi.worktree-setup` and keeps the pane and sidebar entry in sync. If your
work here is done, report that to your parent and let it reap you with
`foreman_reap` rather than tearing down your own worktree — see
`rule://herdr-worktrees`.
