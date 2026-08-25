---
name: foreman-boss
description: Operate foreman as the boss — claim a handle, spawn workers into worktrees, collect their reports, answer their questions, reap when done. Use when bossing parallel branch work or when the user says foreman, boss, or dispatch. Not for a foreman worker itself (read `skill://foreman-worker` instead), and not for local subagents that stay inside this process.
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
both directions goes through herdr's agent surface, which the `foreman_*` tools
and the `foreman` CLI both wrap.

This skill is the boss-side contract. For *what to put in a worker's brief* —
the boss's actual job — read `skill://foreman-dispatch`. For what a worker
itself can do once dispatched, read `skill://foreman-worker` instead — you
should not need it here; every dispatched task already carries its own
protocol block.

Each boss-side operation is a `foreman_*` tool: `foreman_boss`, `foreman_spawn`,
`foreman_send`, `foreman_ask`, `foreman_join`, `foreman_ls`, `foreman_read`,
`foreman_reap`, `foreman_broadcast`, `foreman_dm`, `foreman_keys`,
`foreman_doctor`, `foreman_roles`. Call the tool, not the shell command it
wraps — the reason is not merely style.

Delivery is a real push, not a poll: a worker's `foreman_report`, and your own
dispatch, signal the other side directly and arrive as a non-interrupting
aside — queued behind whatever turn is running, because nobody is waiting on
them. A worker's `foreman_reply` is the one inbound exception: a question means
that worker is *stalled* until you answer, so it cuts into your current turn at
the next tool-call boundary rather than waiting for the turn to end. Handle it
the way you would any interruption you are responsible for — see [Answering a
question](#answering-a-question). If a signal can't be delivered, it falls back
to an interrupting `herdr agent prompt`, so nothing is silently lost; it just
arrives more rudely. Outbound, steering is the deliberate exception:
`foreman_send(raw: true)`, `foreman_broadcast`, `foreman_dm`, and `foreman_keys`
interrupt a worker's *current* turn on purpose, because unblocking a stuck
approval prompt only works if it cuts the queue. A tracked task and a report
never do that — both queue for the worker's next turn. See
[README.md](../../README.md#install) for how the delivery channel is wired up.

Three reasons to prefer the tool over the shell command it wraps: `foreman_spawn`
takes the whole brief as its `task` string and writes the temp file and
passes `--task-file` itself, so no shell quoting can mangle a multi-line
brief; `foreman_join` and `foreman_ask` stream each report as its worker
settles rather than returning one blob at the end of the wave; and the
wrappers return stderr as well as stdout, so a `note()` diagnostic —
including the first-dispatch pickup warning — is not silently dropped the
way it is from a bash call that only captures stdout.

## Requirements

`foreman` comes from the companion herdr plugin, which symlinks it onto your PATH
when herdr starts. If `foreman` is not found, the plugin is not installed. There
is no tool for this — install it from the shell, one of the CLI-only operations
covered below:

```bash
herdr plugin install andyhite/foreman/herdr
```

Every worker process must run inside a herdr pane (`HERDR_ENV=1`).

## Before anything else

```
foreman_boss()
```

Claims a handle for this pane, defaulting to the repo root's name — `webapp`
in `~/Code/acme/webapp`. Workers address their questions to it, so nothing
can be dispatched until it exists. On a pane that already has a handle, a
bare `foreman_boss()` is a query rather than a claim: it prints the existing
one and changes nothing.

Nothing limits how many bosses exist; each just needs a handle no live
agent is using. The repo-root default is only a default — it stops one
checkout from monopolizing a shared name, and `foreman_boss(name: "lead2")`
in the same checkout is a second, equally valid boss. Two unrelated
checkouts with the same directory name derive the same default, and the
second one has to name itself. Claiming a taken handle fails and names the
pane holding it:

```
foreman_boss(name: "lead2")                    # any [a-z][a-z0-9_-]{0,31} name
foreman_boss(name: "webapp", steal: true)      # take it over; the holder is renamed aside, not unnamed
```

Claim the handle **before** spawning. Whichever handle this pane holds at spawn
time is stamped into each worker, and that is where its `foreman_reply` goes.
Renaming a boss afterwards is safe — `foreman_boss(name: "newname")` repoints
every worker that reported to the old handle, and `steal: true` does the same for
the foreman of whoever it displaces.

## Dispatching

One worker per branch. `foreman_spawn` creates the worktree, starts an omp agent in
the workspace's own pane under a handle derived from the branch, builds the
selected layout, and submits the task:

```
foreman_spawn(
  branch: "feat/412-webhook-retry",
  tier: "deep",
  task: "Add exponential backoff to the webhook dispatcher. Tests in
tests/webhooks/. Do not change the public dispatch() signature."
)
```

Write the task the way you would write a local subagent assignment: target
files, concrete change, acceptance criteria. The worker has no memory of this
conversation — every requirement must be in the text. `role` is optional and
accepted once: it looks up a named convention in `roles:` in foreman's config
and prepends that role's mapped skill instruction. Use it where a role such
as `review` should survive a skill rename without changing every dispatch.
`skills` is a list; each entry prepends that skill's instruction. When both
are present, the role-mapped skill comes first, then literal skills in the
order given. Leave both absent and the worker gets the task text alone. A
role can also pin a model — `review: code-review @review` — so
`foreman_spawn(role: "review")` alone applies that model without a separate
`tier`/`model`; an explicit `tier`/`model` at the call site still wins.

`foreman_roles()` prints the current mapping, where its config was found, and
each mapped skill's own frontmatter description as a "what is this role
for" hint — read from the skill itself, not a second copy in the config. A
missing role dies naming the config path it looked for. The config is
project-local: `.foreman/config.yml` at the repo root (or `$FOREMAN_CONFIG`
as an override). `foreman init` scaffolds it if it does not exist yet — one
of the four operations with no tool wrapper, run from the shell:

```bash
foreman init
```

```yaml
roles:
  review: code-review @review
  implement: my-house-implement-skill
```

Long tasks read better from a file, and a brief worth dispatching is almost
always long. With `foreman_spawn` you are spared the file dance entirely: pass
the whole brief as `task` and the wrapper writes it to a temp file and passes
`--task-file` itself. `--task-file` on the raw CLI is only the shape that
fallback takes when no tool is loaded — there is no `task_file` parameter on
the tool; `task` is always the full text.

`tier: "standard" | "deep"` selects a worker model band; `model` is the escape
hatch that passes an omp model selector straight through. The two are
mutually exclusive. `$FOREMAN_AGENT_TIER` sets a default when neither is
passed. `base` overrides the branch point (default: `origin/HEAD`).
`no_dispatch: true` creates the worktree and starts its agent without
assigning work.

`layout: "agent"` (the default) is the worker shape: one `agent` tab, one pane
named for the selected harness. `layout: "full"` is for a worktree a human will
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

**Fan out, then keep working.** The real reason to use foreman, and the
default. Spawn every worker first — each returns as soon as its task is
submitted — then get back to your own work instead of blocking:

```
foreman_spawn(branch: "feat/a", tier: "deep", task: "…")
foreman_spawn(branch: "feat/b", tier: "deep", task: "…")
foreman_spawn(branch: "feat/c", tier: "deep", task: "…")
```

Workers deliver themselves: `foreman_report` and `foreman_reply` push straight
to your pane, tagged `[foreman:<handle>]`, in whatever order the wave settles.
Receiving that costs you nothing — no `foreman_join`, no blocked tool call. So
a later `foreman_join` printing `nothing to join` is not a malfunction; it
means every worker's own push already landed. A slow background sweep covers
only what a push cannot: a worker that ended its turn without reporting, one
whose agent died, and a push that found no live boss.

**A deliberate blocking wait.** Sometimes waiting is still the right call: a
genuine serial dependency (the next step needs one worker's result and
there is nothing else to do until it lands), or you have simply run out of
other work. `foreman_ask(handle, text)` dispatches and blocks for that one
worker; a bare `foreman_join()` blocks for whatever in the wave is still
outstanding — its own tool description says as much. Never reach for either
to *start* a batch — that serializes the thing you came here to parallelize.

Reports reach you as the worker's own push, backed by a file — never from the
terminal. Interactive agent TUIs do not provide a reliable scrollback transport
through herdr; `foreman_read(handle)` shows the visible terminal and is a
debugging aid, not a way to collect durable results.

A report is overwritten only by its own worker, so a follow-up `foreman_send`
leaves the previous one intact. `foreman_join` dates it instead of trusting it: a
report older than the most recent dispatch prints under `(nothing reported since
the last dispatch)` rather than being mistaken for an answer to it.

**Re-joining terminates.** Nothing forces a worker to run `foreman_report` — an
omp that ends its turn is simply idle, and idle settles instantly. So
`foreman_join` records each settle against the dispatch it answers, and a bare
`foreman_join()` skips workers already collected. Re-run it freely; it returns
`nothing to join` once the wave is in, rather than spinning on a worker that
quietly stopped. A `foreman_send` makes that worker joinable again, which is
precisely when re-joining is meaningful. Naming a handle explicitly always
joins it, collected or not.

## Answering a question

A blocked worker runs `foreman_reply` (or the CLI `foreman reply "<question>"`
it wraps). That writes the question to disk as the durable record and wakes
your pane, delivered tagged `[foreman:<handle>]`.

Unlike a report, a question **interrupts** — it lands at the next tool-call
boundary instead of waiting for your turn to finish, because that worker is
stalled until you answer and orchestrating workers is your actual job.

Being interrupted is not permission to drop what you are holding. When one
arrives:

1. Put it on your todo list immediately, so it cannot be forgotten if the
   step you are on turns out to be long.
2. Finish the step you are already on. Never abandon a half-applied edit, a
   partial refactor, or an uncommitted worktree to answer faster.
3. Then answer from the todo, and mark it done.

A question is cheap to answer and expensive to lose: the worker is doing
nothing until you reply, but a repo left half-edited costs you the rest of
the session.

The wake is the primary path — most of the time the question just arrives.
The file is what covers the case a wake cannot: nothing lands *inside* a
running tool call, so a boss sitting in a blocking `foreman_join` or
`foreman_ask` will not see it until that call returns, which by default is an
hour away. A blocking join polls the filed question instead, and breaks out on
any question that is still unanswered — delivered to you or not. That is what
stops it from deadlocking behind a worker waiting on exactly the answer you
are blocking instead of giving. The background sweep is the one reader that
skips a delivered question: re-serving it every tick would be the duplicate
you already have.

Answer it and get back to your own work; the worker resumes and its report
arrives the same way the question did:

```
foreman_send(handle: "feat-412-webhook-retry", text: "Use the existing RetryPolicy in core/retry.ts; don't add a new one.", raw: true)
```

**Use `raw: true` for answers.** Without it `foreman_send` appends the whole
protocol block, which is right for a task and wrong for a reply: re-stating
"do not open a PR unless the task above says to" over a one-line answer makes
*that answer* the task above, and the worker talks itself out of the PR its
brief asked for.

Raw text is steering, not a new tracked dispatch. It does not bump the dispatch
counter or make the worker's eventual report for its original task look stale.
That also means it does not wait for a lifecycle transition: an answer queued
behind a working turn has no transition of its own until that turn yields.

A *follow-up* tracked task is accepted only from `idle` or `done`. Foreman refuses
one while the worker is `working` or `blocked`, because herdr exposes no turn
id: queueing dispatch 2 behind dispatch 1 would let dispatch 1's eventual
report label itself as dispatch 2. Use `raw: true` to steer the current turn; use
an ordinary tracked `foreman_send` for follow-up work after that turn settles. A
worker's first dispatch — the one `foreman_spawn` makes — is exempt, since there
is no earlier report to mislabel.

If `foreman_join` reports a worker as `blocked`, that is herdr seeing an approval
or question UI in the pane, not a `foreman_reply`. Read the pane with
`foreman_read` and answer it with `foreman_send(raw: true)` — a keystroke into
an approval prompt must not carry a protocol block behind it.

## Peer messaging

Three more tools send raw, untracked text — like `foreman_send(raw: true)`, none
of them bump a worker's dispatch counter or touch its report freshness. This
is the boss-initiated side; a worker reaching a peer or you the same
way is covered by `skill://foreman-worker`:

```
foreman_broadcast(text: "Contract changed: retries now live in core/retry.ts.")
foreman_dm(handle: "feat-412-webhook-retry", text: "Are you touching core/retry.ts? I need it untouched for fix-418.")
foreman_keys(handle: "feat-412-webhook-retry", keys: ["down", "down", "enter"])
```

`foreman_broadcast` reaches every live worker in this repo in one call — a
wave-wide notice cheaper than repeating `foreman_send(raw: true)` per handle.
`foreman_dm` is peer to peer: any member — boss or worker — can message any
other by handle, for coordinating over a shared seam rather than for status
updates. `foreman_keys` passes terminal keys straight through to `herdr agent
send-keys`, for unblocking a worker parked on an approval or question UI that
a line of text can't dismiss — read the pane with `foreman_read` first to see
what it is waiting on.

## Finishing

Workers commit to their own branch and stop. They do not push and do not open
PRs unless the task said to. Review the branches yourself, then:

```
foreman_ls()                                     # handles, states, branches, paths
foreman_reap(handles: ["<handle>"])              # remove one worktree
foreman_reap(all: true)                          # remove this repo's worktrees
foreman_reap(handles: ["<handle>"], forget: true) # drop the record, leave the worktree
```

`foreman_reap` refuses a worktree with uncommitted changes unless `force: true`
is set — that refusal is the point; read the diff before reaching for it. It
also throws unless `all: true` or a non-empty `handles` is given: there is no
bare "reap whatever" call. It removes the worktree, never the branch; the
commits are the deliverable.

`forget: true` is the other direction: a worktree you already removed by hand
leaves a record `foreman_reap` can never satisfy, and the worker would otherwise
sit in `foreman_ls` as `gone` forever.

A record whose agent has died still owns its handle. `foreman_spawn` refuses to
reuse one rather than silently repointing it at a new worktree and stranding
the old one — branches collide on handles easily, since `feat/x`, `feat_x` and
`feat-x` all reduce to `feat-x`. Pass `replace: true` to clear the old worktree and
respawn in one step.

Worker state is machine-global, so `foreman_ls`, a bare `foreman_join`, and
`foreman_reap(all: true)` are scoped to the current repo — otherwise they
would block on, and delete, another checkout's foreman. `foreman_ls(all_repos:
true)` widens deliberately, and the same scoping applies to `foreman_reap`.
Outside a git repo there is nothing to scope to, and they refuse rather than
guess.

## Worker states

The boss sees each worker in one of four states:

**`working`** — A turn is running. The worker's current output is in the pane.

**`idle` or `done`** — A turn ended. A report may have been filed
(`foreman_report`), or the turn may have simply completed without one. Either
way, the worker is joinable: `foreman_join` will settle it.

**`blocked`** — An approval or question UI in the pane is waiting for input.
`foreman_join` prints its last output and notes the blockage. Re-join the worker
by name — `foreman_join(handles: ["<handle>"])` — after unblocking it with
`foreman_send(raw: true)`; a bare join will not resurface it.

**`gone`** — The agent process died. The report file, if it exists, survives
and `foreman_join` prints it; the handle remains in `foreman_ls` until
`foreman_reap` or `foreman_reap(forget: true)` releases it.

`foreman_join(timeout_s)` and `foreman_ask(timeout_s)` override
`FOREMAN_WAIT_TIMEOUT_MS` for one call. `foreman_ask` has no `raw` parameter:
raw steering files no report to wait for. `foreman_ls` has a Q column — `?`
marks a worker whose question has not been collected, `-` everyone else.
`foreman_doctor()` checks environment sanity and reports a hard failure;
`foreman version` prints the CLI version — the last of the four CLI-only
operations (alongside `herdr plugin install`, `foreman init`, and `foreman
dashboard`), run from the shell since there is nothing to wrap:

```bash
foreman version
foreman dashboard
```

## What this is not for

- Anything that fits in one repo checkout. Keep it here or use your harness's
  local subagents; they are faster, cheaper, and have a direct message channel.
- Read-only investigation that a local research subagent can do.
- Work with a strict serial dependency chain. A foreman's value is concurrency; a
  chain of one-at-a-time `foreman_ask` calls is a slow, expensive local-agent loop.
