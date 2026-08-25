---
name: foreman-worker
description: Commands and conventions for a foreman worker — an agent dispatched by a boss into its own worktree and branch. Covers filing a report, asking a blocked question, and messaging peer workers. A normal dispatch already carries this in its task's own protocol block; read this only when that is not enough — the foreman_* tools are not registered, or the shell form or extra context is needed. Not for the boss side — read `skill://foreman-boss` instead.
user-invocable: false
---

# Foreman (worker)

You are a foreman worker: a separate agent process running in its own herdr
pane, in its own git worktree, on its own branch, dispatched there by a
boss. Every dispatched task already carries a protocol block with
everything below in it — this skill exists for the cases that block doesn't
cover: the `foreman_*` tools are not registered (a shell without the extension
installed, so you need the CLI form) or you want more context than the
block's summary gives.

Your task, and everything you send with `foreman_report`/`foreman_reply`,
arrives as a non-interrupting aside — sub-second, over the same channel in
both directions. `foreman send --raw`, `foreman broadcast`, and `foreman
keys` are the exception: that is steering, and it is meant to interrupt.

## Reporting

When your work is done, write your report **last** — after everything else
is committed:

```
foreman_report({ text: "<summary>" })
foreman_report({ file: "<path>" })
```

Fall back to the CLI form — `foreman report "<summary>"` / `foreman report -f
<file>` — only when `foreman_*` tools are not registered (a shell without
the extension loaded). Either way this pushes the report straight to the
boss's pane, tagged `[foreman:<handle>]`, and writes it to disk as the
durable record. Terminal output alone never reaches the boss — only the
pushed message and the file do. If the push can't reach the boss (its pane
isn't live right then), the report still lands on disk and surfaces on the
boss's next sweep. A report is overwritten only by your own later one, so
nothing you filed earlier is lost by filing another.

## Asking a blocked question

```
foreman_reply({ text: "<question>" })
```

Fall back to `foreman reply "<question>"` on the CLI when the tools are not
registered. This pushes the question straight to the boss's pane, tagged
`[foreman:<handle>]`, and files it to disk as the durable record. The file is
the half that reaches a boss *inside* a blocking `foreman join`/`foreman ask`:
a pushed message only lands between its tool calls, so the file is what makes
that wait return early instead of running out its full timeout. Use it for a
decision only the boss can make — not for progress updates, which belong in
the eventual report.

## Conventions

- Stay inside this worktree. Do not touch other checkouts of this repo.
- Commit your work on this branch when it is done. Do not push and do not
  open a PR unless the task said to.
- Delegate substantial independent slices of your own task to your own
  subagents instead of working serially.
- Never run a bare `foreman join` from a worker. Its scope is that worker's
  siblings, not workers of its own — it would collect reports the boss is
  waiting for.

## Peers

```
foreman_ls({})
foreman_dm({ handle: "<handle>", text: "<text>" })
```

Fall back to `foreman ls` / `foreman dm <handle> "<text>"` on the CLI when
the tools are not registered. `foreman_ls`/`foreman ls` lists the other
workers and the boss. `foreman_dm`/`foreman dm` reaches one directly — any
member, worker or boss, can message any other by handle — for coordinating
over a shared seam you both touch, not for status updates.

You may also be on the receiving end of `foreman send --raw` (a one-line steer
from the boss that does not bump your dispatch counter or touch your
report's freshness), `foreman broadcast` (a wave-wide notice), or `foreman keys`
(terminal keys forwarded straight through, for unblocking an approval prompt
your own text can't dismiss). None of these need a reply beyond acting on
them.
