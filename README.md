# Foreman

[![version](https://img.shields.io/badge/version-0.14.1-blue)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-omp-orange)](https://github.com/andyhite/herdr)

Foreman lets one agent act as a project manager and hand engineering work to
peer agents, each running on its own git worktree and branch, plus convene
standing expert agents for advisory roles that don't own a branch. It is a
single omp-native agent plugin — one extension (`extension/index.ts`)
exposing eight tools, identical in every session.

| Tool | Purpose |
| --- | --- |
| `foreman_spawn` | Create a worker: new worktree, branch, and first task |
| `foreman_convene` | Create a cluster of standing experts in a new tab, sharing your own checkout |
| `foreman_roles` | List the roles configured in `.foreman/roles.json`, with when to defer to each |
| `foreman_send` | Message a handle on one of your edges — new task, follow-up, or report |
| `foreman_ask` | Ask your parent a question you're blocked on, and block until they answer |
| `foreman_wait` | Block until mail arrives, when you have nothing to do until it does |
| `foreman_ls` | List workers and experts you've spawned or convened: kind, state, branch position, pending mail |
| `foreman_reap` | Remove a worker's worktree/pane, or an expert's pane, and its roster entry |

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

Every session carries the same eight tools; there's no boss mode or worker
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
context. `base` is optional and defaults to the parent's current HEAD. Pass
`role: "<name>"` instead of `brief` to reuse a role from `.foreman/roles.json`
(see `## Roles` below) — it's optional either way.

Convene a cluster of standing experts into a fresh tab, sharing your own
checkout instead of a worktree each:

```
foreman_convene(experts: [
  { handle: "pm", brief: "Standing product manager. Load skill://sprint-planning. Plan the next sprint when asked and reply with ticket ids." },
  { handle: "release", brief: "Standing release engineer. Load skill://release-process. Tag and push releases when asked.", model: "opus" }
])
```

Each expert gets its own pane and agent, starts with the brief as its only
context, and stays convened between requests — send it more work later with
`foreman_send`.

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
- `foreman_reap` refuses dirty or unmerged work unless forced — for a
  worker. An expert has no branch to guard, so reaping one just closes its
  pane.

State — the roster and per-handle mailboxes — lives under `$FOREMAN_STATE`
(default `~/.foreman/<slug>/`, where `<slug>` is the repo's `--git-common-dir`
sanitized into a filesystem-safe name), keyed by handle; nothing is written
into a repo a worker operates on.

## Roles

`.foreman/roles.json`, committed in the repo, defines reusable roles so a
`foreman_spawn` or `foreman_convene` call can say `role: "pm"` instead of
retyping the same brief and skills every time:

```json
{
  "pm": {
    "description": "Owns product scope and prioritization. Defer here for sprint planning, ticket triage, and prioritization calls.",
    "brief": "Standing product manager. Plan the next sprint when asked and reply with ticket ids.",
    "skills": ["skill://sprint-planning"]
  },
  "release": {
    "description": "Owns tagging and publishing. Defer here for release cuts, changelogs, and version bumps.",
    "brief": "Standing release engineer. Tag and push releases when asked.",
    "skills": ["skill://release-process"],
    "model": "opus"
  }
}
```

`description` is never sent to the worker or expert — `foreman_roles` shows
it to the orchestrating agent so it can decide whether an incoming request
belongs to a standing role instead of being handled inline. `brief` and
`skills` seed the child's initial message; per-call `brief`/`skills`
(`role` on `foreman_spawn`, `experts[].role` on `foreman_convene`) append
after the role's own instead of replacing it, and `model` overrides the
role's own. `skills` accepts any number of `skill://` URIs, loaded in
order. A role is optional on both tools — pass an ad hoc `brief` instead
when no configured role fits.

## Skills

- `skill://foreman-spawner` — the parent-seat judgement `foreman_spawn`,
  `foreman_convene`, `foreman_roles`, `foreman_send`, `foreman_ls`, and
  `foreman_reap` don't encode: writing a brief a worker or expert can act
  on, judging an incoming `foreman_ask`, one worker per branch, choosing
  convene vs. spawn, checking configured roles before writing an ad hoc
  brief, and reaping only after merging.
- `skill://foreman-worker` — the child-seat judgement for a spawned worker:
  staying on your own branch, when to ask versus decide, and reporting back
  to your parent.
- `skill://foreman-expert` — the child-seat judgement for a convened expert:
  the shared-checkout hazard, staying convened between requests instead of
  exiting, and reporting back.

A session on both ends of foreman (a worker that has spawned children of its
own) can load both parent- and child-seat skills. Every message a session
receives through foreman carries a reminder pointing back at the right one,
in case the original read has since scrolled out of context.

## Commands

- `/foreman-spawn <goal>` — reads `skill://foreman-spawner`, then decomposes
  `<goal>` into independent slices and dispatches one worker per slice.
- `/foreman-convene <roles>` — reads `skill://foreman-spawner` and
  `skill://foreman-expert`, then works out the standing roles `<roles>`
  calls for and dispatches the whole cluster with one `foreman_convene` call.
- `/foreman-init [notes]` — interviews the user, proposes common roles that
  fit the repo, and writes `.foreman/roles.json`.
