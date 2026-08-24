---
name: fleet-worker
description: Commands and conventions for a fleet worker — an agent dispatched by an orchestrator into its own worktree and branch. Covers filing a report, asking a blocked question, and messaging peer workers. A normal dispatch already carries this in its task's own protocol block; read this only when that is not enough — the fleet_* tools are not registered, or the shell form or extra context is needed. Not for the orchestrator side — read `skill://fleet-orchestrate` instead.
user-invocable: false
---

# Fleet (worker)

You are a fleet worker: a separate agent process running in its own herdr
pane, in its own git worktree, on its own branch, dispatched there by an
orchestrator. Every dispatched task already carries a protocol block with
everything below in it — this skill exists for the cases that block doesn't
cover: the `fleet_*` tools are not registered (a shell without the extension
installed, so you need the CLI form) or you want more context than the
block's summary gives.

## Reporting

When your work is done, write your report **last** — after everything else
is committed:

```bash
fleet report "<summary>"
fleet report -f <file>
```

or the `fleet_report` tool when it's registered. The orchestrator reads that
file; terminal output never reaches it. A report is overwritten only by your
own later one, so nothing you filed earlier is lost by filing another.

## Asking a blocked question

```bash
fleet reply "<question>"
```

or the `fleet_reply` tool. This files the question to disk and interrupts
the orchestrator's pane, so a `fleet join` it is sitting in returns
immediately instead of waiting out its timeout. Use it for a decision only
the orchestrator can make — not for progress updates, which belong in the
eventual report.

## Conventions

- Stay inside this worktree. Do not touch other checkouts of this repo.
- Commit your work on this branch when it is done. Do not push and do not
  open a PR unless the task said to.
- Delegate substantial independent slices of your own task to your own
  subagents instead of working serially.

## Peers

```bash
fleet ls
fleet dm <handle> "<text>"
```

`fleet ls` lists the other workers and the orchestrator. `fleet dm` reaches
one directly — any member, worker or orchestrator, can message any other by
handle — for coordinating over a shared seam you both touch, not for status
updates.

You may also be on the receiving end of `fleet send --raw` (a one-line steer
from the orchestrator that does not bump your dispatch counter or touch your
report's freshness), `fleet broadcast` (a wave-wide notice), or `fleet keys`
(terminal keys forwarded straight through, for unblocking an approval prompt
your own text can't dismiss). None of these need a reply beyond acting on
them.
