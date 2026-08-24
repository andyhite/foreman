# Foreman (herdr plugin)

Foreman is one of two plugins in this repo (`andyhite/foreman`): this herdr plugin supplies the `foreman` CLI, the mechanism that spawns and manages workers; the companion agent plugin at [the repo root](../) supplies the `/foreman:*` boss commands that drive it. omp's own `task` subagents share one process, context, and current directory; a foreman worker is a separate coding-agent process (`foreman spawn --kind`, default `omp`) in its own herdr pane, git worktree, and branch. That worker remains reachable through herdr after the original dispatch, including an hour later.

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
| `foreman spawn <branch> [opts]` | Create a worktree, start an agent, and dispatch work. Options: `--base`, `--repo`, `--path`, `--handle`, `--kind`, `--skill`, `--layout`, `--task`, `--task-file`, `--no-dispatch`, `--replace`. |
| `foreman send [--raw] <handle> <text>` | Dispatch a tracked task and return; `--raw` steers the current turn. |
| `foreman ask [--timeout <seconds>] <handle> <text>` | Send, then block for the response. Rejects `--raw` because there is no report to wait for. For ask the flag comes first. |
| `foreman join [handle...] [--timeout <seconds>]` | Collect this repository's workers and print each report as it settles. `--timeout` overrides `FOREMAN_WAIT_TIMEOUT_MS` for this call. |
| `foreman ls [--all-repos]` | List workers and their states. Includes a Q column: `?` marks a worker whose filed question has not been collected by a join, `-` everyone else. |
| `foreman dashboard [--all-repos]` | Interactive counterpart to `foreman ls`; also aliased `dash`. |
| `foreman read <handle> [-n N]` | Read a worker's terminal. |
| `foreman reap <handle>...\|--all` | Remove worktrees and forget workers. `--all` covers this repository, `--all-repos` every repository, `--force` overrides the refusal to remove a worktree with uncommitted changes, `--forget` drops the record and leaves the worktree alone. |
| `foreman report [-f file\|text]` | From a worker, file its report. |
| `foreman reply <text>` | From a worker, file a question and interrupt the boss. |
| `foreman whoami` | Print this pane's handle. |
| `foreman version` | Print the CLI version, read at runtime from `herdr-plugin.toml` so it cannot drift from the plugin manifest. |
| `foreman doctor` | Environment sanity check: `HERDR_ENV`, herdr on PATH (with version), `jq`, pane id, agent handle, `$FOREMAN_STATE` writability, the PATH symlink, and the current repo's worker count. Prints one ok/warn/fail line per check; exits nonzero on any hard failure. Works outside herdr to help diagnose foreman misbehavior. |

### Collecting

`foreman join` polls every worker it is watching rather than waiting on them in
order, so a worker that finishes first is printed first and a worker whose
agent is no longer live is reported as `gone` instead of aborting the whole
collection.

A settle is recorded against the dispatch counter it answers. A bare
`foreman join` skips workers already collected at their current counter, so
re-joining terminates rather than returning instantly, forever, on a worker
that ended its turn without ever running `foreman report`. A `foreman send` bumps
that counter and makes the worker joinable again — which is exactly when
re-joining means something. Naming a handle explicitly always joins it.

`foreman reply` writes the question to disk *and* prompts the boss.
The file is the load-bearing half: herdr's prompt only reaches a boss
that is between tool calls, and one sitting inside `foreman join` does not read
its input until that call returns. `join` polls for filed questions and
returns as soon as one appears, which is what actually lets a blocked worker
preempt the wave. Answer it with `foreman send --raw`.

### Timeout control

`foreman join [--timeout <seconds>]` and `foreman ask [--timeout <seconds>]` (flag first for ask) override `FOREMAN_WAIT_TIMEOUT_MS` for a single call. Non-numeric values cause an error with usage displayed.

### `--raw`

Without `--raw`, `send` and `ask` both append foreman's protocol block — right for a task,
wrong for a one-line answer. Re-appending "do not open a PR unless the task
above says to" over an answer makes *that answer* the task above, which is how
a worker talks itself out of the PR its original brief asked for. `--raw` is
also the only way to put a bare keystroke into a worker blocked on an approval
prompt.

Raw text is steering, not a new tracked dispatch. It does not bump the dispatch
counter or make the worker's eventual report for its original task look stale,
and it does not wait for an agent lifecycle transition — a keystroke into a
blocked approval UI may leave the agent blocked, and an answer queued behind a
working turn has no transition of its own yet.

A *re*-dispatch is accepted only from `idle` or `done`. Foreman refuses one while
the worker is `working` or `blocked`: herdr exposes no turn id, so if dispatch
2 were queued while dispatch 1 was running, dispatch 1's eventual report would
read the now-current counter and label itself as dispatch 2. Use `--raw` to
steer the current turn, or collect it before assigning another task.

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
| `s` / `S` | dispatch a task (`foreman send`) / steer the current turn (`foreman send --raw`) |
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

Answering a question with `a` is a raw send plus the acknowledgement `foreman
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
| `FOREMAN_AGENT_KIND` | `omp` | Harness started for new workers unless `foreman spawn --kind` overrides it. |
| `FOREMAN_WAIT_TIMEOUT_MS` | `3600000` | Maximum milliseconds for one `foreman ask` or `foreman join`. |
| `FOREMAN_DISPATCH_SETTLE_MS` | `15000` | Maximum milliseconds to verify that a dispatched prompt reached the expected worker state. |
| `FOREMAN_JOIN_POLL_MS` | `2000` | How often `foreman join` re-reads the workers it is watching. |
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
