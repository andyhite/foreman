# Foreman

[![version](https://img.shields.io/badge/version-0.10.0-blue)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-omp-orange)](https://github.com/andyhite/herdr)

Foreman lets one agent act as a project manager and hand engineering work to
peer agents, each running on its own git worktree and branch. It is a single
omp-native agent plugin — one extension (`extension/index.ts`) exposing six
tools, identical in every session.

| Tool | Purpose |
| --- | --- |
| `foreman_spawn` | Create a worker: new worktree, branch, and first task |
| `foreman_send` | Message a handle on one of your edges — new task, follow-up, or report |
| `foreman_ask` | Ask your parent a question you're blocked on, and block until they answer |
| `foreman_wait` | Block until mail arrives, when you have nothing to do until it does |
| `foreman_ls` | List workers you've spawned: state, branch position, pending mail |
| `foreman_reap` | Remove a worker's worktree, pane, and roster entry after merge |

---

## The idea

omp's `task` subagents share one process: one context window, one working
directory, one lifetime. That fits work confined to the current checkout —
not work that needs its own branch.

A worker spawned by `foreman_spawn` is a full omp process instead: its own
context window, its own git worktree, reachable an hour later, delivering a
branch rather than a message. Foreman manages the worktrees, branches,
workers, and reports. It has no opinion on *how* a worker does its job — it
ships no execution skills of its own. Name any required procedure in the
brief, the way you'd brief a stranger.

Every session carries the same five tools; there's no boss mode or worker
mode. "Parent" and "worker" just name the two ends of a spawn edge: whoever
calls `foreman_spawn` is the parent, the session it creates is the child. A
child that spawns children of its own is a parent on one edge and a child on
another — no extra concept needed. `foreman_ask` always goes to your own
parent; worker-to-worker messaging is out of scope by construction, not
policy. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full
design rationale.

## Requirements

- [herdr](https://github.com/andyhite/herdr), and a herdr pane
  (`HERDR_ENV=1`) — worktree panes are how workers get a terminal
- A git repository
- macOS or Linux

## Install

Via the marketplace (recommended — enables `/marketplace upgrade`):

```
/marketplace add andyhite/foreman
/marketplace install foreman@foreman
```

Direct git install:

```sh
omp install github:andyhite/foreman
```

For a local checkout instead of GitHub:

```sh
omp install ./
```

Restart the session after installing; extension modules load only at
startup, so `/mcp reconnect` or similar is not enough.

## Use

From a parent session, spawn a worker onto a fresh branch and worktree with
its first task:

```
foreman_spawn(handle: "webhooks", branch: "feat/webhook-retry",
  brief: "Add exponential backoff to the webhook dispatcher in
  lib/webhooks/dispatch.ts. Tests in tests/webhooks/. Do not change the
  public dispatch() signature.")
```

The worker starts with no conversation history — the brief is its entire
context. `base` is optional and defaults to the parent's current HEAD.

Beyond the table above:

- `foreman_send` never interrupts: a busy worker finishes its current run
  first, an idle one wakes within milliseconds.
- `foreman_ask` does interrupt your parent's in-flight tool call, then blocks
  until they answer — the answer comes back as the tool's own result, so you
  carry straight on instead of ending your turn. Call it only once you've
  actually stalled.
- `foreman_wait` blocks without sending anything, for when you have nothing
  useful to do until a worker reports. Both bound at 5 minutes by default,
  after which they tell you to end your turn and the message arrives the
  ordinary way instead.
- `foreman_reap` refuses dirty or unmerged work unless forced.

State — the roster and per-handle mailboxes — lives under `$FOREMAN_STATE`
(default `~/.foreman/<slug>/`, where `<slug>` is the repo's `--git-common-dir`
sanitized into a filesystem-safe name), keyed by handle; nothing is written
into a repo a worker operates on.

## Skills

- `skill://foreman-spawner` — the parent-seat judgement `foreman_spawn`,
  `foreman_send`, `foreman_ls`, and `foreman_reap` don't encode: writing a
  brief a worker can act on, judging an incoming `foreman_ask`, one worker
  per branch, and reaping only after merging.
- `skill://foreman-worker` — the child-seat judgement: staying on your own
  branch, when to ask versus decide, and reporting back to your parent.

A session on both ends of foreman (a worker that has spawned children of its
own) can load both. Every message a session receives through foreman carries
a reminder pointing back at the right one, in case the original read has
since scrolled out of context.

## Commands

- `/foreman-spawn <goal>` — reads `skill://foreman-spawner`, then decomposes
  `<goal>` into independent slices and dispatches one worker per slice.
