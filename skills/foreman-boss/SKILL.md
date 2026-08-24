---
name: foreman-boss
description: Operate the `foreman` CLI as the boss — claim a handle, spawn workers into worktrees, collect their reports, answer their questions, reap when done. Use when bossing parallel branch work or when the user says foreman, boss, or dispatch. Not for a foreman worker itself (read `skill://foreman-worker` instead), and not for local subagents that stay inside this process.
user-invocable: false
---

# Foreman (boss)

Dispatch work to coding-agent processes that are not yours.

Local subagents (`task` in omp) share this process: one context window, one cwd,
one lifetime, and they die when this session does. A foreman worker is a separate
agent process running in its own herdr pane, in its own git worktree, on its own
branch. It has a full context window, it can be talked to an hour from now, and
its output is a branch rather than a message.

That independence is also the cost. Harness-local channels such as omp's `hub`,
`history://`, and `agent://` do not reach a separate process. Every message in
both directions goes through herdr's agent surface, which `foreman` wraps.

This skill is the CLI contract for the boss side. For *what to put in
a worker's brief* — the boss's actual job — read
`skill://foreman-dispatch`. For what a worker itself can do once dispatched,
read `skill://foreman-worker` instead — you should not need it here; every
dispatched task already carries its own protocol block.

Every `foreman_*` custom tool (`foreman_boss`, `foreman_spawn`, `foreman_send`, …) is
the CLI subcommand of the same name, one parameter for one flag. The CLI is
the contract; the tools are the interface — call the tool when one is
registered, and fall back to the shell form shown in this doc only where no
tool is loaded (a shell without the extension installed). Both hit the
identical command underneath.

## Requirements

`foreman` comes from the companion herdr plugin, which symlinks it onto your PATH
when herdr starts. If `foreman` is not found, the plugin is not installed:

```bash
herdr plugin install andyhite/foreman/herdr
```

Every command must run inside a herdr pane (`HERDR_ENV=1`) and needs `jq`.

## Before anything else

```bash
foreman boss
```

Claims a handle for this pane, defaulting to the repo root's name — `webapp`
in `~/Code/acme/webapp`. Workers address their questions to it, so nothing
can be dispatched until it exists. On a pane that already has a handle, a bare
`foreman boss` is a query rather than a claim: it prints the existing one and
changes nothing.

Nothing limits how many bosses exist; each just needs a handle no live
agent is using. The repo-root default is only a default — it stops one checkout
from monopolizing a shared name, and `foreman boss <name>` in the same checkout is
a second, equally valid boss. Two unrelated checkouts with the same
directory name derive the same default, and the second one has to name itself.
Claiming a taken handle fails and names the pane holding it:

```bash
foreman boss lead2          # any [a-z][a-z0-9_-]{0,31} name
foreman boss webapp --steal   # take it over; the holder is renamed aside, not unnamed
```

Claim the handle **before** spawning. Whichever handle this pane holds at spawn
time is stamped into each worker, and that is where its `foreman reply` goes.
Renaming a boss afterwards is safe — `foreman boss <newname>` repoints
every worker that reported to the old handle, and `--steal` does the same for
the foreman of whoever it displaces.

## Dispatching

One worker per branch. `spawn` creates the worktree, starts an omp agent in
the workspace's own pane under a handle derived from the branch, builds the
selected layout, and submits the task:

```bash
foreman spawn feat/412-webhook-retry --tier deep \
  --task "Add exponential backoff to the webhook dispatcher. Tests in
tests/webhooks/. Do not change the public dispatch() signature."
```

Write the task the way you would write a local subagent assignment: target
files, concrete change, acceptance criteria. The worker has no memory of this
conversation — every requirement must be in the text. `--role <name>` is
optional and accepted once: it looks up a named convention in `roles:` in
foreman's config and prepends that role's mapped skill instruction. Use it
where a role such as `review` should survive a skill rename without
changing every dispatch. `--skill <name>` is repeatable; each occurrence
prepends that skill's instruction. When both are present, the role-mapped
skill comes first, then literal skills in the order passed. Leave both
absent and the worker gets the task text alone. A role can also pin a
model — `review: code-review @review` — so `--role review` alone applies
that model without a separate `--tier`/`--model`; an explicit
`--tier`/`--model` at the call site still wins.

`foreman roles` prints the current mapping, where its config was found, and
each mapped skill's own frontmatter description as a "what is this role
for" hint — read from the skill itself, not a second copy in the config. A
missing role dies naming the config path it looked for. The config is
project-local: `.foreman/config.yml` at the repo root (or `$FOREMAN_CONFIG`
as an override). `foreman init` scaffolds it if it does not exist yet:

```yaml
roles:
  review: code-review @review
  implement: my-house-implement-skill
```

Long tasks read better from a file, and a brief worth dispatching is almost
always long:

```bash
foreman spawn fix/301-null-guard --tier deep --task-file /tmp/task-301.md
```

`--tier standard|deep` selects a worker model band; `--model <selector>` is
the escape hatch that passes an omp model selector straight through. The two
are mutually exclusive. `$FOREMAN_AGENT_TIER` sets a default when neither flag
is passed. `--base` overrides the branch point (default: `origin/HEAD`).
`--no-dispatch` creates the worktree and starts its agent without assigning
work.

`--layout agent` (the default) is the worker shape: one `agent` tab, one pane
named for the selected harness. `--layout full` is for a worktree a human will
also occupy:

```text
agent tab:  <agent> | nvim
shell tab:  zsh
review tab: lazygit (or a shell when lazygit is unavailable)
```

Foreman builds that shape from `herdr tab`/`pane` commands directly, so it needs
no layout plugin. It also refuses to race one: if an enabled
`herdr-plugin-workspace-manager` config covers the repo, spawn stops before
creating a branch or worktree and names the config entry to remove. `$FOREMAN_EDITOR`
and `$FOREMAN_GIT_UI` override `nvim` and `lazygit`.

## Collecting

Two modes, and picking the wrong one is the main way this goes badly.

**Fan out, then join.** The real reason to use foreman. Spawn every worker first —
each returns as soon as its task is submitted — then block once:

```bash
foreman spawn feat/a --tier deep --task-file /tmp/a.md
foreman spawn feat/b --tier deep --task-file /tmp/b.md
foreman spawn feat/c --tier deep --task-file /tmp/c.md
foreman join
```

`join` watches every live worker at once and prints each report the moment that
worker settles, so the one that finishes first is the one you read first. A
worker whose agent is no longer live prints as `gone` and the rest of the wave
still comes back — one dead pane does not discard the collection.

**One at a time.** `foreman ask <handle> "<task>"` dispatches and blocks for that
one worker. Use it for a follow-up on an existing worker, or when the second
task genuinely depends on the first one's result. Never use it to start a batch
— it serializes the thing you came here to parallelize.

Reports come from files, not the terminal. Interactive agent TUIs do not provide
a reliable scrollback transport through herdr; `foreman read <handle>` shows the
visible terminal and is a debugging aid, not a way to collect durable results.

A report is overwritten only by its own worker, so a follow-up `foreman send`
leaves the previous one intact. `join` dates it instead of trusting it: a report
older than the most recent dispatch prints under `(nothing reported since the
last dispatch)` rather than being mistaken for an answer to it.

**Re-joining terminates.** Nothing forces a worker to run `foreman report` — an
omp that ends its turn is simply idle, and idle settles instantly. So `join`
records each settle against the dispatch it answers, and a bare `foreman join`
skips workers already collected. Re-run it freely; it returns
`nothing to join` once the wave is in, rather than spinning on a worker that
quietly stopped. A `foreman send` makes that worker joinable again, which is
precisely when re-joining is meaningful. Naming a handle explicitly always
joins it, collected or not.

## When a worker interrupts you

A blocked worker runs `foreman reply "<question>"`. That does two things: it
prompts your pane, so the question arrives as a user message tagged
`[foreman:<handle>]`, and it files the question to disk.

The file is the half that matters. A herdr prompt only reaches you *between*
tool calls — a boss sitting inside `foreman join` does not read its
input until that call returns, which by default is an hour away. So `join`
polls for filed questions itself and returns the instant one appears, printing
it. That is what actually lets a worker waiting on a decision jump the queue
instead of sitting behind another worker's build.

Answer it and resume:

```bash
foreman send --raw <handle> "Use the existing RetryPolicy in core/retry.ts; don't add a new one."
foreman join
```

**Use `--raw` for answers.** Without it `send` appends the whole protocol block,
which is right for a task and wrong for a reply: re-stating "do not open a PR
unless the task above says to" over a one-line answer makes *that answer* the
task above, and the worker talks itself out of the PR its brief asked for.

Raw text is steering, not a new tracked dispatch. It does not bump the dispatch
counter or make the worker's eventual report for its original task look stale.
That also means it does not wait for a lifecycle transition: an answer queued
behind a working turn has no transition of its own until that turn yields.

A *follow-up* tracked task is accepted only from `idle` or `done`. Foreman refuses
one while the worker is `working` or `blocked`, because herdr exposes no turn
id: queueing dispatch 2 behind dispatch 1 would let dispatch 1's eventual
report label itself as dispatch 2. Use `--raw` to steer the current turn; use
ordinary `foreman send` for follow-up work after that turn settles. A worker's
first dispatch — the one `foreman spawn` makes — is exempt, since there is no
earlier report to mislabel.

If `join` reports a worker as `blocked`, that is herdr seeing an approval or
question UI in the pane, not a `foreman reply`. Read the pane with `foreman read`
and answer it with `foreman send --raw` — a keystroke into an approval prompt
must not carry a protocol block behind it.

## Peer messaging

Three more commands send raw, untracked text — like `foreman send --raw`, none
of them bump a worker's dispatch counter or touch its report freshness. This
is the boss-initiated side; a worker reaching a peer or you the same
way is covered by `skill://foreman-worker`:

```bash
foreman broadcast "Contract changed: retries now live in core/retry.ts."
foreman dm feat-412-webhook-retry "Are you touching core/retry.ts? I need it untouched for fix-418."
foreman keys feat-412-webhook-retry down down enter
```

`broadcast` reaches every live worker in this repo in one call — a wave-wide
notice cheaper than repeating `foreman send --raw` per handle. `dm` is peer to
peer: any member — boss or worker — can message any other by handle,
for coordinating over a shared seam rather than for status updates. `keys`
passes terminal keys straight through to `herdr agent send-keys`, for
unblocking a worker parked on an approval or question UI that a line of text
can't dismiss — read the pane with `foreman read <handle>` first to see what it
is waiting on.

## Finishing

Workers commit to their own branch and stop. They do not push and do not open
PRs unless the task said to. Review the branches yourself, then:

```bash
foreman ls                     # handles, states, branches, paths
foreman reap <handle>          # remove one worktree
foreman reap --all             # remove this repo's worktrees
foreman reap <handle> --forget # drop the record, leave the worktree
```

`reap` refuses a worktree with uncommitted changes. That refusal is the point —
read the diff before reaching for `--force`. It removes the worktree, never the
branch; the commits are the deliverable.

`--forget` is the other direction: a worktree you already removed by hand
leaves a record `reap` can never satisfy, and the worker would otherwise sit in
`foreman ls` as `gone` forever.

A record whose agent has died still owns its handle. `foreman spawn` refuses to
reuse one rather than silently repointing it at a new worktree and stranding
the old one — branches collide on handles easily, since `feat/x`, `feat_x` and
`feat-x` all reduce to `feat-x`. Pass `--replace` to clear the old worktree and
respawn in one step.

Worker state is machine-global, so `ls`, a bare `join`, and `reap --all` are
scoped to the current repo — otherwise they would block on, and delete, another
checkout's foreman. `--all-repos` widens `ls` and `reap` deliberately. Outside a
git repo there is nothing to scope to, and they refuse rather than guess.

## Worker states

The boss sees each worker in one of four states:

**`working`** — A turn is running. The worker's current output is in the pane.

**`idle` or `done`** — A turn ended. A report may have been filed
(`foreman report`), or the turn may have simply completed without one. Either
way, the worker is joinable: `foreman join` will settle it.

**`blocked`** — An approval or question UI in the pane is waiting for input.
`foreman join` prints its last output and notes the blockage. Re-join the worker
by name — `foreman join <handle>` — after unblocking it with `foreman send --raw`;
a bare join will not resurface it.

**`gone`** — The agent process died. The report file, if it exists, survives
and `join` prints it; the handle remains in `foreman ls` until `foreman reap`
or `foreman reap --forget` releases it.

`foreman join --timeout <seconds>` and `foreman ask --timeout <seconds>` override
`FOREMAN_WAIT_TIMEOUT_MS` for one call. `foreman ask` rejects `--raw`: raw
steering files no report to wait for. `foreman ls` has a Q column — `?` marks a
worker whose question has not been collected, `-` everyone else. `foreman doctor`
checks environment sanity and exits nonzero on a hard failure; `foreman version`
prints the CLI version.

## What this is not for

- Anything that fits in one repo checkout. Keep it here or use your harness's
  local subagents; they are faster, cheaper, and have a direct message channel.
- Read-only investigation that a local research subagent can do.
- Work with a strict serial dependency chain. A foreman's value is concurrency; a
  chain of one-at-a-time `foreman ask` calls is a slow, expensive local-agent loop.
