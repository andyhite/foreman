# fleet (omp plugin)

Orchestrator-side commands for omp. They turn a session into a project manager:
you collect the requirements, and each piece of execution work is dispatched to
a peer omp agent running the matching [mattpocock/skills](https://github.com/mattpocock/skills)
skill on its own branch.

## Why

The mattpocock skills split cleanly along a line that nobody usually draws:
some of them need the user in the room, and some of them just need a checkout.

`grill-me`, `to-spec`, `to-tickets`, `triage`, `wayfinder` are interviews and
backlog work — they belong wherever the human is. `implement`,
`diagnosing-bugs`, `research`, `prototype`, `code-review` are autonomous, they
run long, and they each want a branch to themselves.

Running both halves in one session means the long half blocks the interactive
half, and one context window holds everything. This plugin keeps the interactive
half with you and sends the autonomous half to [fleet](../../herdr/) workers —
separate `omp` processes, one per branch, running in parallel.

## Requirements

- The [herdr fleet plugin](../../herdr/), which puts the `fleet` CLI on your PATH
- [mattpocock/skills](https://github.com/mattpocock/skills) installed and
  reachable as `skill://<name>` (user scope, so workers see them too)
- A session running inside a herdr pane (`HERDR_ENV=1`)

Run `/setup-matt-pocock-skills` once per repo before using `/fleet:implement`,
`/fleet:code-review`, or `/fleet:backlog` — they read
`docs/agents/issue-tracker.md`, and `/fleet:backlog` cannot run without it.

## Install

```
/marketplace add andyhite/foreman
/marketplace install fleet@omp-fleet
```

## Commands

Start here. It claims your orchestrator handle and defines the role:

```
/fleet:boss <objective>
```

Then dispatch, one command per kind of work:

| Command | Worker runs | For |
|---|---|---|
| `/fleet:implement` | `skill://implement` | building a spec or set of tickets |
| `/fleet:diagnosing-bugs` | `skill://diagnosing-bugs` | a bug or performance regression |
| `/fleet:research` | `skill://research` | a question needing primary sources |
| `/fleet:prototype` | `skill://prototype` | a design question needing something runnable |
| `/fleet:code-review` | `skill://code-review` | reviewing a branch a worker already produced |

And one command that runs that whole loop for you, when the work is already in
the tracker rather than in the conversation:

| Command | For |
|---|---|
| `/fleet:backlog` | walk the tracker's dependency graph, dispatch every ready ticket to the skill that matches it, review and merge what comes back, recompute the frontier, repeat |

`/fleet:backlog` is the only one that merges. The per-ticket commands stop when
the worker reports, which is correct for one slice and fatal for a backlog: a
dependent ticket reaches the frontier only when its blocker *closes*, and that
needs a merge. Reporting and waiting stalls after the first wave.

Every dispatch command does the same three things: check that you can state the
requirements precisely, write a brief to a file, and `fleet spawn` a worker
against it. What differs is *which* requirements that skill cannot proceed
without — the seams `/tdd` will test at, the reproduction steps a feedback loop
needs, the fixed point a review diffs against. Each command asks for its own;
`/fleet:backlog` asks for a whole wave's worth in one round.

## Skills

- `skill://fleet-dispatch` — what stays with the orchestrator, what goes to a
  worker, and the anatomy of a brief. The contract the commands share.
- `skill://fleet` — the `fleet` CLI itself: spawning, joining, replying, reaping.

## How dispatch actually works

The execution skills are marked `disable-model-invocation: true`, so they are
hidden from the list an agent selects from and it never reaches for one on its
own. They stay reachable by URI. A worker is a blank omp process whose first
input is the brief, which begins:

```
Read `skill://implement` and follow it for the work below.
```

That instruction is what puts the skill in front of the worker. `fleet` then
appends its own protocol block telling the worker how to commit, how to file
its report, and how to interrupt you with a question, so briefs never repeat
any of it.
