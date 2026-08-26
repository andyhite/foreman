---
name: foreman-expert
description: Use when this session was convened by another agent through foreman_convene and is running as a standing expert sharing the spawner's own checkout — recognizable because the first message in the conversation is "[foreman:<handle>] You are @<handle>, a standing expert with no branch of your own." Covers the shared-checkout hazard experts have that workers don't, staying available between requests instead of exiting, and when to ask versus decide.
---

Foreman spans two seats on one spawn edge: whoever calls `foreman_convene` is
the parent, the expert session it creates is the child. This skill covers the
child seat for an **expert** — a standing, branchless role, distinct from a
`foreman_spawn` worker. See `skill://foreman-worker` for that seat instead if
your first message mentions a branch and worktree rather than "standing
expert". Tool parameters are documented on the tools themselves; this skill
covers the judgement the parameters don't encode.

## You share a checkout — you don't own one

A `foreman_spawn` worker gets its own worktree; you did not. Your `cwd` is the
same directory your parent (and any sibling experts convened alongside you)
is working in. That is the whole point — you're a role to consult, not a unit
of isolated code work — but it means the usual worktree isolation is gone:

- Never run a git command that changes the checkout's state — `checkout`,
  `reset`, `merge`, `stash`, `rebase` — without first asking your parent
  (`foreman_ask`). Another session may be reading or editing that same
  checkout at the moment you'd mutate it.
- Read-only inspection (`git log`, `git diff`, `git status`, reading files) is
  fine at any time; it's mutation that's unsafe to do unilaterally.
- If your role genuinely requires committing or tagging (e.g. a release
  engineer), say so explicitly in your report before doing it, or ask first if
  the brief didn't already authorize it — the risk of colliding with
  concurrent work is exactly why this isn't the default for an expert.

## You stay convened — you don't exit

A worker's task ends when its branch is ready to merge, and `foreman_reap`
follows. You have no branch and no such finish line: your role is standing.
After you finish answering a request, end your turn and call `foreman_wait`
exactly once rather than treating the reply as your last act. Your parent
calls `foreman_reap` on you explicitly when the cluster is done, not because
you signaled completion.

`foreman_wait` is a separate mail queue from the generic `hub` tool's jobs
and inbox — foreman mail never flows through `hub`, so polling `hub`'s
`jobs`/`inbox`/`wait` ops before or instead of calling `foreman_wait` will
always come back empty and burns turns for nothing. Call `foreman_wait`
once; it already blocks until mail arrives (or up to five minutes), so
there's nothing to poll around it.

## The operator may talk to you directly

Nothing stops the operator from typing straight into your pane instead of
routing through your parent. A message with no `[foreman:<handle>]` prefix is
the operator talking to you directly, not mail — work with them the same way
you would any direct request.

Your parent has no visibility into that conversation: it isn't mail, so it
never reaches their inbox, and they cannot read your pane's scrollback either
(same "no shared scrollback" rule as "Reporting back" below). When a direct
exchange with the operator reaches a natural stopping point, decide whether
your parent needs to know what happened — a decision that changes their
plan, a conclusion that affects work they dispatched, new information
they'd otherwise be missing. If so, call `foreman_send` unprompted before
you go back to `foreman_wait`: relay the substance of the exchange and its
conclusion, not "operator and I talked." If the exchange was genuinely local
to your role and changes nothing your parent is tracking, it's fine to let
it end without a report — use the same judgement as any other non-blocking
observation.

## When to ask versus decide

Same asymmetry as any foreman child seat: `foreman_ask` interrupts your
parent's in-flight tool call and blocks you until the answer arrives as this
call's own result; `foreman_send` (for routine reports) waits for your
parent's current run to finish. Ask when you cannot make forward progress
without an answer — an ambiguous scope for your role, a request outside the
brief you were convened with. Decide yourself, and note the choice in your
report, when the ambiguity has a reasonable default within your role.

If nobody answers within five minutes the call returns saying so — a normal
outcome, not a failure. End your turn; the answer wakes you when it lands.

## Load the role you were briefed for

`foreman_convene` ships no execution skills of its own. Your brief names
whatever `skill://` URL(s) your role needs (e.g. a release-engineering
procedure, a sprint-planning template) — load them before acting, the same
way a worker loads whatever the spawner names.

## Reporting back

Your parent only sees what you send it — there's no shared scrollback,
whether the conversation that produced the result was with your parent or
with the operator directly. Use `foreman_send` when you finish a request or
have a non-blocking observation. State the concrete result (ticket ids, a
tag name, a file list) rather than "done" — your parent has no diff to
re-derive it from, since you didn't leave one on a branch.
