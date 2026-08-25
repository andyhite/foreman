---
name: foreman-worker
description: Commands and conventions for a foreman worker — an agent dispatched by a boss into its own worktree and branch. Covers filing a report, asking a blocked question, and messaging peer workers. A normal dispatch already carries this in its task's own protocol block; read this only when that is not enough — the foreman_* tools are not registered, or the shell form or extra context is needed. Not for the boss side — read `skill://foreman-boss` instead.
user-invocable: false
---

# Foreman (worker)

You are a foreman worker: a separate agent process running in its own herdr
pane, in its own git worktree, on its own branch, dispatched there by a
boss. Your task carries its own protocol block covering the basics — stay in
this worktree, commit before you're done, report last, ask when blocked,
message peers, delegate substantial slices — so this skill does not repeat
them. Read it here only for what the block's summary leaves out: exact
fallback CLI forms for when the `foreman_*` tools are not registered, and
behavior the block doesn't spell out.

Everything you send the boss interrupts it: `foreman_report` when you finish,
`foreman_reply` when you block. That is by design — orchestrating workers is
the boss's actual job, and it knows how to absorb an interruption without
dropping what it holds. It is not free, though, so file one report when you
are done, and ask a question only when you are genuinely blocked, never to
check in.

Inbound is the other way round. A task the boss dispatches waits for your next
turn rather than cutting into a half-applied edit. The exception is steering —
`foreman send --raw`, `foreman broadcast`, `foreman keys` — which interrupts you
on purpose, and is how an answer to your question gets back fast.

## Reporting

```
foreman_report({ text: "<summary>" })
foreman_report({ file: "<path>" })
```

Fall back to the CLI form — `foreman report "<summary>"` / `foreman report -f
<file>` — only when `foreman_*` tools are not registered. Either way this
pushes the report straight to the boss's pane and writes it to disk as the
durable record; terminal output alone never reaches the boss. If the push
can't reach the boss right then, the report still lands on disk and surfaces
on the boss's next sweep. A report is overwritten only by your own later one.

## Asking a blocked question

```
foreman_reply({ text: "<question>" })
```

Fall back to `foreman reply "<question>"` on the CLI when the tools are not
registered. The file half is what reaches a boss *inside* a blocking
`foreman join`/`foreman ask`: a pushed message only lands between its tool
calls, so the file is what makes that wait return early instead of running
out its full timeout. Use it for a decision only the boss can make, not for
progress updates — those belong in the eventual report.

## Peers

```
foreman_ls({})
foreman_dm({ handle: "<handle>", text: "<text>" })
```

Fall back to `foreman ls` / `foreman dm <handle> "<text>"` on the CLI when
the tools are not registered. `foreman_dm`/`foreman dm` reaches one peer
directly — any member, worker or boss, can message any other by handle — for
coordinating over a shared seam you both touch, not for status updates.

Never run a bare `foreman join` from a worker: its scope is *your* siblings,
not workers of your own, so it would collect reports your boss is waiting
for.

You may also be on the receiving end of `foreman send --raw` (a one-line steer
from the boss that does not bump your dispatch counter or touch your
report's freshness), `foreman broadcast` (a wave-wide notice), or `foreman keys`
(terminal keys forwarded straight through, for unblocking an approval prompt
your own text can't dismiss). None of these need a reply beyond acting on
them.
