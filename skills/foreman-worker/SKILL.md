---
name: foreman-worker
description: Commands and conventions for a foreman worker — an agent dispatched by a boss into its own worktree and branch. Covers filing a report, asking a blocked question, and messaging peer workers via the foreman_* tools. Every dispatch points here automatically; read it before doing anything else. Not for the boss side — read `skill://foreman-boss` instead.
user-invocable: false
---

# Foreman (worker)

You are a foreman worker: a separate agent process running in its own herdr
pane, in its own git worktree, on its own branch, dispatched there by a
boss. This is the contract for how you get work done without going silent on
the boss: stay in this worktree, commit before you're done, report last, ask
when blocked, message peers, delegate substantial slices. Your task's own
protocol block only reinforces the tool names below; this skill is where the
behavior actually lives.

Everything below is a `foreman_*` tool call: file a report, ask a blocked
question, or reach a peer.

The two things you send the boss do not arrive the same way.
`foreman_reply` interrupts it, because you are blocked until it answers —
that is by design: orchestrating workers is the boss's actual job, and it
knows how to absorb an interruption without dropping what it holds.
`foreman_report` does not interrupt; it queues to the boss's next turn
boundary, because finished work can wait. Neither is free, so file one report
when you are done, and ask a question only when you are genuinely blocked,
never to check in.

Use `hub`/`task` for your own subagents exactly as you normally would —
nothing about this changes. The one thing `hub` cannot do is see a foreman
worker or boss: `hub wait`, `hub inbox`, and `hub send` only carry traffic
between subagents inside your own process, so there is no way to poll for a
`foreman_reply` answer through them. Keep working if you can, otherwise end
your turn — an idle worker is woken when the answer arrives.

Nothing inbound interrupts you. A task the boss dispatches waits for your next
turn rather than cutting into a half-applied edit. So does `foreman_msg` —
it queues behind your current turn just like a task, because `h agent
prompt`, what both use underneath, lands at a turn boundary, never mid-turn.
`foreman_keys` is the one exception: terminal keys bypass your input queue
entirely, which is how an answer to a stuck approval prompt reaches you
immediately when text queued behind it could not.

Delegate substantial independent slices of your own task to your own
subagents instead of working them serially — the same reason your boss
dispatched you instead of doing the work itself.

## Reporting

```
foreman_report({ text: "<summary>" })
foreman_report({ file: "<path>" })
```

This pushes the report straight to the boss's pane and writes it to disk as
the durable record; terminal output alone never reaches the boss. If the
push can't reach the boss right then, the report still lands on disk and
surfaces on the boss's next sweep. A report is overwritten only by your own
later one.

## Asking a blocked question

```
foreman_reply({ text: "<question>" })
```

The file half is what reaches a boss *inside* a blocking
`foreman_join`: a pushed message only lands between its tool calls, so the
file is what makes that wait return early instead of running
out its full timeout. Use it for a decision only the boss can make, not for
progress updates — those belong in the eventual report.

## Peers

```
foreman_ls({})
foreman_msg({ handle: "<handle>", text: "<text>" })
```

`foreman_msg` reaches one peer directly — any member, worker or boss, can
message any other by handle, or address `all` for every live worker in the
repo — for coordinating over a shared seam you both touch, not for status
updates.

Never call `foreman_join` from a worker: its scope is *your* siblings, not
workers of your own, so it would collect reports your boss is waiting for.

You may also be on the receiving end of `foreman_msg` (an untracked note from
the boss or a peer, prefixed `[foreman msg from <sender>]`, that does not
bump your dispatch counter or touch your report's freshness — it queues
behind whatever turn you are in, the same as a task) or `foreman_keys`
(terminal keys forwarded straight through, for unblocking an approval prompt
your own text can't dismiss because it never reaches the input queue). None
of these need a reply beyond acting on them.
