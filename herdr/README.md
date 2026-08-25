# Foreman (herdr plugin)

Foreman is one of two plugins in this repo (`andyhite/foreman`): this herdr plugin supplies the `foreman` CLI, the mechanism that spawns and manages workers; the companion agent plugin at [the repo root](../) supplies the `/foreman:*` boss commands that drive it. omp's own `task` subagents share one process, context, and current directory; a foreman worker is a separate coding-agent process in its own herdr pane, git worktree, and branch. That worker remains reachable through herdr after the original dispatch, including an hour later.

## Requirements

- herdr 0.8.0 or newer
- `jq`
- macOS or Linux
- A herdr pane: foreman commands require `HERDR_ENV=1`

## Install

```sh
herdr plugin install andyhite/foreman/herdr
```

For a local clone instead:

```sh
herdr plugin link ./herdr
```

Installing the plugin is what puts `foreman` on your PATH. Its startup hook creates `$HOME/.local/bin/foreman` as a symlink to the plugin binary. Set `FOREMAN_LINK_DIR` to place that symlink in another directory.

The hook only ever replaces a symlink that resolves into a checkout of *this* plugin, matched by the `id` in its `herdr-plugin.toml` — so moving between an installed copy and a `herdr plugin link`ed working copy repoints cleanly. Everything else at that path is left exactly as it is, with a warning: a regular file, a symlink to another tool, another plugin's own `bin/foreman`, or a broken symlink. A broken symlink is not adopted either; it can't be identified, and replacing it would destroy the only record of where it pointed.

## Commands

| Command | Description |
| --- | --- |
| `foreman boss [name] [--steal]` | Claim the boss handle for this pane. |
| `foreman spawn <branch> [opts]` | Create a worktree, start an agent, and dispatch work. Options: `--base`, `--repo`, `--path`, `--handle`, `--tier`, `--model`, `--skill`, `--role`, `--layout`, `--task`, `--task-file`, `--no-dispatch`, `--replace`. |
| `foreman send <handle> <text>` | Dispatch a tracked task and return; queues behind the worker's current turn. |
| `foreman msg <handle\|all> <text>` | Untracked text to one member by handle or every live worker in this repository; queues the same as `send`, prefixed `[foreman msg from <sender>]`, and never bumps the dispatch counter. |
| `foreman join [handle...] [--timeout <seconds>] [--once]` | Collect this repository's workers and print each report as it settles. `--timeout` overrides `FOREMAN_WAIT_TIMEOUT_MS` for this call. `--once` runs a single non-blocking poll pass instead of the blocking deadline loop. |
| `foreman ls [--all-repos]` | List workers and their states. Includes a Q column: `?` marks a worker whose filed question has not been collected by a join, `-` everyone else. |
| `foreman dashboard [--all-repos]` | Interactive counterpart to `foreman ls`; also aliased `dash`. |
| `foreman read <handle> [-n N]` | Read a worker's terminal. |
| `foreman reap <handle>...\|--all` | Remove worktrees and forget workers. `--all` covers this repository, `--all-repos` every repository, `--force` overrides the refusal to remove a worktree with uncommitted changes, `--forget` drops the record and leaves the worktree alone. A report that was filed but never collected is printed to stderr first: the record being removed is where it lived. |
| `foreman keys <handle> <key>...` | Send terminal keys straight through to `herdr agent send-keys`; how you clear a worker stuck on an approval prompt — the only channel that reaches one immediately instead of queuing. |
| `foreman report [-f file\|text]` | From a worker, file its report. |
| `foreman reply <text>` | From a worker, file a question and interrupt the boss. |
| `foreman whoami` | Print this pane's handle. |
| `foreman version` | Print the CLI version, read at runtime from `herdr-plugin.toml` so it cannot drift from the plugin manifest. |
| `foreman roles` | List the role → skill mappings read from foreman's project-local config, plus each mapped skill's own frontmatter description as a hint. |
| `foreman init` | Scaffold `.foreman/config.yml` at the repo root, commented and empty. Refuses to overwrite an existing file. |
| `foreman doctor` | Environment sanity check: `HERDR_ENV`, herdr on PATH (with version), `jq`, pane id, agent handle, `$FOREMAN_STATE` writability, the PATH symlink, the current repo's worker count, the role config, and whether this pane has a live bus sidecar. Prints one ok/warn/fail line per check; exits nonzero on any hard failure. Works outside herdr to help diagnose foreman misbehavior. The bus line is the one to read when a *task* arrives as an interruption instead of waiting for the worker's next turn: no live sidecar means every delivery is taking the `herdr agent prompt` fallback, which interrupts in both directions. |

### Role config

`roles:` in `.foreman/config.yml` at the repo root maps a `--role` name to one
skill, so a named house convention (`review`, `implement`) survives a skill
rename without touching every dispatch site. The file is project-local by
design — one repo's convention should not leak into every other checkout on
the machine — and travels with the checkout the same way any other committed
config does, including into a worker's own worktree. `foreman init` creates it;
`foreman roles` shows what it currently resolves to, plus each mapped
skill's own frontmatter `description:` — read straight from the skill,
wherever it actually lives (project or global), so there is no second copy
of that text to keep in sync — as a hint for what the role is actually for.
`$FOREMAN_CONFIG` is an escape hatch that overrides the repo-local lookup
outright, for testing or a config that intentionally lives elsewhere.

A role maps to a skill in one of two ways:

- `name: skill` (default) — load the skill as reference material before the
  task, same as `--skill`. Right for content meant to be read and applied by
  judgment: `code-review`, `tdd`, `domain-modeling`.
- `name: command:skill` — invoke the skill instead, the way omp's own
  `/skill:<name>` does: the dispatched task becomes that command's argument
  text rather than a task decorated with reference material. Right for a
  skill marked `disable-model-invocation: true` — it expects to be invoked
  with an argument, not kept passively in mind (`triage`, `to-spec`, an
  `implement` protocol).

Append a second, space-separated token to pin the role to a model, exactly
like `--model` for one `foreman spawn` — a plain selector or an omp
`@modelRole` alias (see omp's own model-role docs). It survives a model
rename the same way the skill mapping survives a skill rename, and it is
only a default: an explicit `--tier`/`--model` at the call site still wins.

```yaml
roles:
  review: code-review @review
  implement: my-house-implement-skill
  triage: command:triage
```

### Collecting

`foreman report` and `foreman reply` deliver to the boss themselves: each rings
the boss's bus sidecar, and the omp extension on the other side pulls the
content with `foreman pickup` and injects it. Only `foreman reply` interrupts,
and only because a worker is blocked until the boss answers; it carries the
protocol for absorbing that without abandoning half-done work. Everything
else queues to the receiver's next turn boundary — a report, a dispatched
task, a `foreman msg` either direction. With no sidecar to ring, the push
falls back to `herdr agent prompt`, tagged `[foreman:<handle>]`, which
interrupts in both directions.

Only a delivery that actually moved text stamps an acknowledgement counter —
`joined` for a report, `question.seen` for a question. A rung doorbell carries
no payload, so it stamps nothing: the `foreman pickup` it wakes is what
delivers and therefore what stamps. Stamping on the bell marked every report
collected before anyone had been handed it.

`foreman join` is for two things now: an explicit re-read of one worker
(`foreman join <handle>` always reprints, delivered or not), or a deliberate
blocking wait (`foreman join` with no handle, or `foreman join <handle>`
right after a `foreman send` to that handle) when there is genuinely
nothing else to do. A blocking join returns early on any question
that is still unanswered, delivered or not, since a pushed prompt cannot reach
a boss that is itself stuck inside that same blocking call — and it hands over
the question body, because `question.seen` records that pickup handed the text
to omp, never that the boss read it. Only the `--once` sweep skips a delivered
one, so a timer cannot re-serve the same question every tick.

`foreman join --once` is a single non-blocking sweep, not a delivery path: it
picks up what a push could not — a worker that ended its turn without ever
running `foreman report`, a worker whose agent died, and a report or
question that was filed but could not be pushed (boss pane not live at the
time). It polls every worker it is watching rather than waiting on them in
order, so a worker that finishes first is printed first and a worker whose
agent is no longer live is reported as `gone` instead of aborting the whole
collection. A settle is recorded against the dispatch counter it answers,
so a bare `foreman join` skips a worker already collected at its current
counter — a `foreman send` bumps that counter and makes the worker joinable
again, which is exactly when re-joining means something. `--once` exits `3`
when there is nothing registered in this repo to sweep (no workers, or
everything already collected); exit `0` means a tick ran, whether or not it
printed anything.

### Timeout control

`foreman join [--timeout <seconds>]` overrides `FOREMAN_WAIT_TIMEOUT_MS` for
a single call — the only timeout knob now that a blocking dispatch is
`foreman send <handle> <text>` followed by `foreman join <handle> [--timeout
<seconds>]` rather than one combined verb. Non-numeric values cause an error
with usage displayed.

### `msg` versus `send`

`send` always appends foreman's protocol block — right for a task, wrong for
a one-line answer. Re-appending "do not open a PR unless the task above says
to" over an answer makes *that answer* the task above, which is how a worker
talks itself out of the PR its original brief asked for. `msg` sends the
text alone, prefixed `[foreman msg from <sender>]`, which is what a reply, a
peer coordination note, or a wave-wide notice to `all` actually needs.

Both queue: `msg` is untracked, not a lower-latency channel. `h agent
prompt`, what the fallback delivery for both uses, lands at the target's
next turn boundary, never mid-turn — an answer queued behind a working turn
simply waits there, the same as a task would. `foreman keys` is the one
command that reaches a worker immediately, because terminal keys bypass the
input queue rather than joining it; it is the only way to put a keystroke
into a worker blocked on an approval prompt.

`msg` does not bump the dispatch counter or make the worker's eventual
report for its original task look stale, and — when the target has a filed
question — it stamps the same acknowledgement a `join` would have on
collection, so answering a question over `msg` still clears the `?` in
`foreman ls`.

A *re*-dispatch with `send` is accepted only from `idle` or `done`. Foreman
refuses one while the worker is `working` or `blocked`: herdr exposes no
turn id, so if dispatch 2 were queued while dispatch 1 was running, dispatch
1's eventual report would read the now-current counter and label itself as
dispatch 2. `msg` has no such gate — it never touches the counter — so it is
what reaches a worker mid-turn; use an ordinary `send` for follow-up work
once that turn actually settles.

A worker's first dispatch is exempt, because there is no earlier report to
mislabel. A freshly started worker may still be initializing or sitting on a
first-run trust prompt, and refusing there would fail a `spawn` whose worktree,
agent and layout already exist. Foreman submits and says it could not confirm
pickup, rather than failing.

### Dashboard

`foreman dashboard` is the interactive counterpart to `foreman ls`: the same
inventory, but with a cursor and the operations that act on a row attached to
that row. Reach it three ways — `foreman dashboard` typed in any pane, the
command palette action "Foreman dashboard", or a keybinding:

```toml
[[keys.command]]
key = "prefix+f"
type = "shell"
description = "foreman dashboard"
command = "herdr plugin pane open --plugin andyhite.foreman --entrypoint dashboard"
```

`type = "shell"`, not `type = "plugin_action"`. herdr runs a shell binding
detached, which is what this needs; see below.

It opens as a popup, not a split or a tab, because a popup is something you
open, act in, and dismiss, and it leaves the tiled layout — including the
agent panes it is reporting on — exactly as it found it.

A popup is a singleton, and the command palette is itself a popup. At the
moment the palette dispatches the action it is still holding the slot, and
herdr answers "popup already open" — so the obvious fix, retrying until the
slot frees, cannot work: the palette closes when the action it dispatched
returns, so retrying in the foreground holds open the very modal it is waiting
on. The action hands the open to a detached child and returns immediately.
The child waits out any modal that is genuinely in the way, up to
`FOREMAN_DASHBOARD_OPEN_TIMEOUT_S`; anything that is not a modal is reported on
the first attempt.

Because the action is gone by then, the child keeps its own record rather than
the plugin log: `dashboard-open.log` in the plugin's herdr state directory
(`herdr plugin config-dir` names the sibling config one). It also attempts a
top-right toast, which shows up only when `ui.toast.delivery` is on — it
defaults to `off`, so the log is the half that is always written.

| Keys | Action |
| --- | --- |
| `j`/`down`, `k`/`up` | move the selection |
| `g`, `G` | jump to the first or last worker |
| `A` | toggle between this repository and every repository on the machine |
| `R` | refresh now (the list also refreshes on its own) |
| `r` | view the worker's full filed report |
| `t` | view the last lines of the worker's terminal |
| `l` | view this dashboard's own operation log |
| `?` | view this keymap |
| `enter` | focus the worker's agent and close the dashboard |
| `s` / `S` | dispatch a task (`foreman send`) / send an untracked note (`foreman msg`) |
| `a` | answer a pending question |
| `n` | spawn a new worker (`foreman spawn`, in the background) |
| `x` / `X` | reap the worker (`foreman reap`) / reap and discard uncommitted work (`foreman reap --force`) |
| `q` / `esc` | quit |

Each row carries a `D R J` flag group that `foreman ls` has no room for: the
send/report/collect state a plain listing cannot show. `D` is the dispatch
counter — how many tasks the worker has been given. `R` is `+` when a report
answering that current dispatch is on disk and `-` when it is not. `J` is `^`
when that dispatch has not yet been collected by a `foreman join` and `.` when
it has.

The glyph in front of a row is `>` working, `!` blocked, `*` done, `o` idle,
`x` no live agent, or `?` — an unanswered question, which outranks every
other status because a worker waiting on you is the one thing in a wave that
stops everything else from mattering.

Two things about how it is built are worth knowing. Every mutation shells out
to the `foreman` subcommand that already owns that operation rather than
reimplementing dispatch inline, so the semantics have exactly one
implementation. And `enter` does not focus the worker directly: the popup is
session-modal, so a focus issued while it is still open lands underneath it;
the dashboard closes first and issues the focus from a detached child a beat
later, once the modal is actually gone.

Answering a question with `a` is a `foreman msg` plus the acknowledgement `foreman
join` would have written on collection — without it the question would stay
pending forever, since nothing else records that it was seen. `n` runs `foreman
spawn` detached rather than inline, because spawn blocks for as long as an
agent takes to boot, and a session-modal popup would freeze for that whole
duration instead of showing the worker the moment herdr names it.

### Recovering a dead worker

A record with no live agent is a worker that died, not a free handle. `spawn`
refuses it rather than overwriting `BRANCH`/`DIR`/`WORKSPACE` and stranding the
old worktree where no foreman command can find it — branches collapse onto one
handle easily, since `feat/x`, `feat_x` and `feat-x` all slugify to `feat-x`.
Pass `--replace` to remove the recorded workspace and respawn, or clear the
record with `foreman reap <handle> [--forget]`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOREMAN_STATE` | `${XDG_STATE_HOME:-$HOME/.local/state}/foreman` | Directory holding foreman's machine-local worker metadata. |
| `FOREMAN_SPAWN_TIMEOUT_MS` | `120000` | Maximum milliseconds to wait for a fresh worker's named, input-ready startup; herdr clamps it to 300000. |
| `FOREMAN_AGENT_TIER` | unset | Worker model tier (`standard`\|`deep`) for new workers unless `foreman spawn --tier` overrides it; empty means omp's own default. An explicit `--model` beats an env-derived tier. |
| `FOREMAN_WAIT_TIMEOUT_MS` | `3600000` | Maximum milliseconds for one `foreman join`. |
| `FOREMAN_DISPATCH_SETTLE_MS` | `15000` | Maximum milliseconds to verify that a dispatched prompt reached the expected worker state. |
| `FOREMAN_JOIN_POLL_MS` | `2000` | How often `foreman join` re-reads the workers it is watching. |
| `FOREMAN_ASIDE_POLL_MS` | `60000` | How often the omp extension's own sweeper (`foreman join --once`) runs, to catch anomalies a push cannot: a worker that ended its turn without reporting, a dead worker, or an undelivered push. |
| `FOREMAN_EDITOR` | `nvim` | Editor command run beside the agent in the `full` layout. |
| `FOREMAN_GIT_UI` | `lazygit` | Git UI command run beside the agent in the `full` layout. |
| `FOREMAN_LAYOUT_START_TIMEOUT_MS` | `15000` | Maximum milliseconds to verify that a layout's requested TUI became foreground before retrying. |
| `FOREMAN_BOSS_HANDLE` | slugified repository-root name (or `boss` outside a repository) | Overrides the default boss handle claimed by `foreman boss`. |
| `FOREMAN_IGNORE_WORKSPACE_MANAGER` | unset | Set to `1` to skip the workspace-manager coexistence gate. |
| `FOREMAN_DASHBOARD_POLL_MS` | `2000` | How long the dashboard waits for a keystroke before redrawing; also its whole polling cost, one `agent list` per tick. |
| `FOREMAN_DASHBOARD_TAIL_LINES` | `200` | Lines of a worker's terminal the dashboard's `t` key pulls. |
| `FOREMAN_DASHBOARD_OPEN_TIMEOUT_S` | `3` | Seconds the palette action waits for herdr's single popup slot to free before reporting that it could not open. |

Every timeout above is a wall-clock budget computed as an absolute deadline.
An inner herdr call is handed what remains of the budget rather than the whole
of it, so a retry loop cannot multiply the bound by the number of attempts.

## Coexistence with workspace-manager

`foreman spawn` checks whether the enabled `herdr-plugin-workspace-manager` has a
configured workspace covering the repository or the worktree about to be created
in it. Enablement is read from `herdr plugin list --json`. The config is looked
up the way the plugin itself looks it up: `$HERDR_WSM_CONFIG` wins outright,
then the directory `herdr plugin config-dir` reports, then the legacy
`~/.herdr/plugins/herdr-plugin-workspace-manager/config.yml`.

Both kinds of entry under `workspaces:` are honoured. A `repo:` entry is
compared by git common directory, with `~/` expanded, and a bare repository
name is matched by basename. A `path:` entry is prefix-matched against the
worktree path foreman is about to create, since that is what the plugin itself
matches against.

If covered, foreman refuses the spawn instead of racing workspace-manager to
create or lay out the workspace. Set `FOREMAN_IGNORE_WORKSPACE_MANAGER=1` to
proceed anyway — worth knowing about when the covering layout starts no agent
of its own, since refusing outright otherwise makes the repository unusable by
foreman without editing another plugin's global config.

## Tests

No framework, no dependencies beyond what foreman itself needs. Run them under
the oldest bash you support as well; several cases only fail there.

```sh
herdr/test/foreman-test.sh          # the CLI
herdr/test/foreman-link-test.sh     # the PATH symlink and its ownership receipt
herdr/test/foreman-dashboard-test.sh   # the dashboard
/bin/bash herdr/test/foreman-test.sh   # macOS system bash 3.2
```

For the agent-facing orchestration commands — the `/foreman:*` slash commands that
dispatch work to these workers — see the companion agent plugin at
[the repo root](../). It is harness-portable (omp, Claude Code, Codex; Cursor untested).
