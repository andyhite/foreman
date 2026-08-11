---
name: fleet
description: Operate the `fleet` CLI — create a worktree per task, dispatch a separate coding-agent process into each, collect reports, and answer worker questions. Use when orchestrating parallel branch work or when the user says fleet, orchestrator, or dispatch. Not for local subagents that stay inside this process.
user-invocable: false
---

# Fleet

Dispatch work to coding-agent processes that are not yours.

Local subagents (`task` in omp) share this process: one context window, one cwd,
one lifetime, and they die when this session does. A fleet worker is a separate
agent process running in its own herdr pane, in its own git worktree, on its own
branch. It has a full context window, it can be talked to an hour from now, and
its output is a branch rather than a message.

That independence is also the cost. Harness-local channels such as omp's `hub`,
`history://`, and `agent://` do not reach a separate process. Every message in
both directions goes through herdr's agent surface, which `fleet` wraps.

This skill is the CLI contract. For *what to put in a worker's brief* — the
orchestrator's actual job — run `fleet skill fleet-dispatch`.

## Requirements

`fleet` comes from the companion herdr plugin, which symlinks it onto your PATH
when herdr starts. If `fleet` is not found, the plugin is not installed:

```bash
herdr plugin install andyhite/foreman/herdr
```

Every command must run inside a herdr pane (`HERDR_ENV=1`) and needs `jq`.

## Before anything else

```bash
fleet boss
```

Claims a handle for this pane, defaulting to the repo root's name — `webapp`
in `~/Code/acme/webapp`. Workers address their questions to it, so nothing
can be dispatched until it exists. On a pane that already has a handle, a bare
`fleet boss` is a query rather than a claim: it prints the existing one and
changes nothing.

Nothing limits how many orchestrators exist; each just needs a handle no live
agent is using. The repo-root default is only a default — it stops one checkout
from monopolizing a shared name, and `fleet boss <name>` in the same checkout is
a second, equally valid orchestrator. Two unrelated checkouts with the same
directory name derive the same default, and the second one has to name itself.
Claiming a taken handle fails and names the pane holding it:

```bash
fleet boss fleetlead        # any [a-z][a-z0-9_-]{0,31} name
fleet boss webapp --steal   # take it over; the holder is renamed aside, not unnamed
```

Claim the handle **before** spawning. Whichever handle this pane holds at spawn
time is stamped into each worker, and that is where its `fleet reply` goes.
Renaming an orchestrator afterwards is safe — `fleet boss <newname>` repoints
every worker that reported to the old handle, and `--steal` does the same for
the fleet of whoever it displaces.

## Dispatching

One worker per branch. `spawn` creates the worktree, starts the selected agent
harness in the workspace's own pane under a handle derived from the branch,
builds the selected layout, and submits the task:

```bash
fleet spawn feat/412-webhook-retry --kind claude --tier deep --skill implement \
  --task "Add exponential backoff to the webhook dispatcher. Tests in
tests/webhooks/. Do not change the public dispatch() signature."
```

Write the task the way you would write a local subagent assignment: target
files, concrete change, acceptance criteria. The worker has no memory of this
conversation — every requirement must be in the text. `--skill` prepends the
portable instruction that loads its procedure; `fleet` appends the protocol
block (report, reply, commit, stay-in-worktree), so repeat neither one.

Long tasks read better from a file, and a brief worth dispatching is almost
always long:

```bash
fleet spawn fix/301-null-guard --tier deep --skill diagnosing-bugs --task-file /tmp/task-301.md
```

`--kind` chooses any harness supported by `herdr agent start` and defaults to
`$FLEET_AGENT_KIND`, then `omp`. The orchestrator and worker kinds are
independent: an omp session can dispatch Claude or Codex workers. `--tier
standard|deep` selects a worker model band (mapped per kind inside the CLI);
`--model <selector>` is the escape hatch that passes a harness selector
straight through. The two are mutually exclusive. `$FLEET_AGENT_TIER` sets a
default when neither flag is passed. `--base` overrides the branch point
(default: `origin/HEAD`). `--no-dispatch` creates the worktree and starts its
agent without assigning work.

`--layout agent` (the default) is the worker shape: one `agent` tab, one pane
named for the selected harness. `--layout full` is for a worktree a human will
also occupy:

```text
agent tab:  <agent> | nvim
shell tab:  zsh
review tab: lazygit (or a shell when lazygit is unavailable)
```

Fleet builds that shape from `herdr tab`/`pane` commands directly, so it needs
no layout plugin. It also refuses to race one: if an enabled
`herdr-plugin-workspace-manager` config covers the repo, spawn stops before
creating a branch or worktree and names the config entry to remove. `$FLEET_EDITOR`
and `$FLEET_GIT_UI` override `nvim` and `lazygit`.

## Collecting

Two modes, and picking the wrong one is the main way this goes badly.

**Fan out, then join.** The real reason to use fleet. Spawn every worker first —
each returns as soon as its task is submitted — then block once:

```bash
fleet spawn feat/a --tier deep --skill implement --task-file /tmp/a.md
fleet spawn feat/b --tier deep --skill implement --task-file /tmp/b.md
fleet spawn feat/c --tier deep --skill implement --task-file /tmp/c.md
fleet join
```

`join` watches every live worker at once and prints each report the moment that
worker settles, so the one that finishes first is the one you read first. A
worker whose agent is no longer live prints as `gone` and the rest of the wave
still comes back — one dead pane does not discard the collection.

**One at a time.** `fleet ask <handle> "<task>"` dispatches and blocks for that
one worker. Use it for a follow-up on an existing worker, or when the second
task genuinely depends on the first one's result. Never use it to start a batch
— it serializes the thing you came here to parallelize.

Reports come from files, not the terminal. Interactive agent TUIs do not provide
a reliable scrollback transport through herdr; `fleet read <handle>` shows the
visible terminal and is a debugging aid, not a way to collect durable results.

A report is overwritten only by its own worker, so a follow-up `fleet send`
leaves the previous one intact. `join` dates it instead of trusting it: a report
older than the most recent dispatch prints under `(nothing reported since the
last dispatch)` rather than being mistaken for an answer to it.

**Re-joining terminates.** Nothing forces a worker to run `fleet report` — an
omp that ends its turn is simply idle, and idle settles instantly. So `join`
records each settle against the dispatch it answers, and a bare `fleet join`
skips workers already collected. Re-run it freely; it returns
`nothing to join` once the wave is in, rather than spinning on a worker that
quietly stopped. A `fleet send` makes that worker joinable again, which is
precisely when re-joining is meaningful. Naming a handle explicitly always
joins it, collected or not.

## When a worker interrupts you

A blocked worker runs `fleet reply "<question>"`. That does two things: it
prompts your pane, so the question arrives as a user message tagged
`[fleet:<handle>]`, and it files the question to disk.

The file is the half that matters. A herdr prompt only reaches you *between*
tool calls — an orchestrator sitting inside `fleet join` does not read its
input until that call returns, which by default is an hour away. So `join`
polls for filed questions itself and returns the instant one appears, printing
it. That is what actually lets a worker waiting on a decision jump the queue
instead of sitting behind another worker's build.

Answer it and resume:

```bash
fleet send --raw <handle> "Use the existing RetryPolicy in core/retry.ts; don't add a new one."
fleet join
```

**Use `--raw` for answers.** Without it `send` appends the whole protocol block,
which is right for a task and wrong for a reply: re-stating "do not open a PR
unless the task above says to" over a one-line answer makes *that answer* the
task above, and the worker talks itself out of the PR its brief asked for.

Raw text is steering, not a new tracked dispatch. It does not bump the dispatch
counter or make the worker's eventual report for its original task look stale.
That also means it does not wait for a lifecycle transition: an answer queued
behind a working turn has no transition of its own until that turn yields.

A *follow-up* tracked task is accepted only from `idle` or `done`. Fleet refuses
one while the worker is `working` or `blocked`, because herdr exposes no turn
id: queueing dispatch 2 behind dispatch 1 would let dispatch 1's eventual
report label itself as dispatch 2. Use `--raw` to steer the current turn; use
ordinary `fleet send` for follow-up work after that turn settles. A worker's
first dispatch — the one `fleet spawn` makes — is exempt, since there is no
earlier report to mislabel.

If `join` reports a worker as `blocked`, that is herdr seeing an approval or
question UI in the pane, not a `fleet reply`. Read the pane with `fleet read`
and answer it with `fleet send --raw` — a keystroke into an approval prompt
must not carry a protocol block behind it.

## Finishing

Workers commit to their own branch and stop. They do not push and do not open
PRs unless the task said to. Review the branches yourself, then:

```bash
fleet ls                     # handles, states, kinds, branches, paths
fleet reap <handle>          # remove one worktree
fleet reap --all             # remove this repo's worktrees
fleet reap <handle> --forget # drop the record, leave the worktree
```

`reap` refuses a worktree with uncommitted changes. That refusal is the point —
read the diff before reaching for `--force`. It removes the worktree, never the
branch; the commits are the deliverable.

`--forget` is the other direction: a worktree you already removed by hand
leaves a record `reap` can never satisfy, and the worker would otherwise sit in
`fleet ls` as `gone` forever.

A record whose agent has died still owns its handle. `fleet spawn` refuses to
reuse one rather than silently repointing it at a new worktree and stranding
the old one — branches collide on handles easily, since `feat/x`, `feat_x` and
`feat-x` all reduce to `feat-x`. Pass `--replace` to clear the old worktree and
respawn in one step.

Worker state is machine-global, so `ls`, a bare `join`, and `reap --all` are
scoped to the current repo — otherwise they would block on, and delete, another
checkout's fleet. `--all-repos` widens `ls` and `reap` deliberately. Outside a
git repo there is nothing to scope to, and they refuse rather than guess.

## Worker states

The orchestrator sees each worker in one of four states:

**`working`** — A turn is running. The worker's current output is in the pane.

**`idle` or `done`** — A turn ended. A report may have been filed
(`fleet report`), or the turn may have simply completed without one. Either
way, the worker is joinable: `fleet join` will settle it.

**`blocked`** — An approval or question UI in the pane is waiting for input.
`fleet join` prints its last output and notes the blockage. Re-join the worker
by name — `fleet join <handle>` — after unblocking it with `fleet send --raw`;
a bare join will not resurface it.

**`gone`** — The agent process died. The report file, if it exists, survives
and `join` prints it; the handle remains in `fleet ls` until `fleet reap`
or `fleet reap --forget` releases it.

`fleet join --timeout <seconds>` and `fleet ask --timeout <seconds>` override
`FLEET_WAIT_TIMEOUT_MS` for one call. `fleet ask` rejects `--raw`: raw
steering files no report to wait for. `fleet ls` has a Q column — `?` marks a
worker whose question has not been collected, `-` everyone else. `fleet doctor`
checks environment sanity and exits nonzero on a hard failure; `fleet version`
prints the CLI version.

## What this is not for

- Anything that fits in one repo checkout. Keep it here or use your harness's
  local subagents; they are faster, cheaper, and have a direct message channel.
- Read-only investigation that a local research subagent can do.
- Work with a strict serial dependency chain. A fleet's value is concurrency; a
  chain of one-at-a-time `fleet ask` calls is a slow, expensive local-agent loop.
