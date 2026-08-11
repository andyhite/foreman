# Fleet

Fleet packages the `fleet` CLI as a herdr plugin. omp's own `task` subagents share one process, context, and current directory; a fleet worker is a separate `omp` in its own herdr pane, git worktree, and branch. That worker remains reachable through herdr after the original dispatch, including an hour later.

## Requirements

- herdr 0.8.0 or newer
- `jq`
- macOS or Linux
- A herdr pane: fleet commands require `HERDR_ENV=1`

## Install

```sh
herdr plugin install andyhite/foreman/herdr
```

For a local clone instead:

```sh
herdr plugin link ./herdr
```

Installing the plugin is what puts `fleet` on your PATH. Its startup hook creates `$HOME/.local/bin/fleet` as a symlink to the plugin binary. Set `FLEET_LINK_DIR` to place that symlink in another directory.

The hook only ever replaces a symlink that resolves into a checkout of *this* plugin, matched by the `id` in its `herdr-plugin.toml` — so moving between an installed copy and a `herdr plugin link`ed working copy repoints cleanly. Everything else at that path is left exactly as it is, with a warning: a regular file, a symlink to another tool, another plugin's own `bin/fleet`, or a broken symlink. A broken symlink is not adopted either; it can't be identified, and replacing it would destroy the only record of where it pointed.

## Commands

| Command | Description |
| --- | --- |
| `fleet boss [name] [--steal]` | Claim the orchestrator handle for this pane. |
| `fleet spawn <branch> [opts]` | Create a worktree, start an agent, and dispatch work. Options: `--base`, `--repo`, `--path`, `--handle`, `--layout`, `--task`, `--task-file`, `--no-dispatch`. |
| `fleet send <handle> <text>` | Dispatch work and return immediately. |
| `fleet ask <handle> <text>` | Dispatch work and block for the response. |
| `fleet join [handle...]` | Block on this repository's workers and print reports. |
| `fleet ls [--all-repos]` | List workers and their states. |
| `fleet read <handle> [-n N]` | Read a worker's terminal. |
| `fleet reap <handle>\|--all` | Remove worktrees and forget workers. |
| `fleet report [-f file\|text]` | From a worker, file its report. |
| `fleet reply <text>` | From a worker, interrupt the orchestrator. |
| `fleet whoami` | Print this pane's handle. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLEET_STATE` | `${XDG_STATE_HOME:-$HOME/.local/state}/fleet` | Directory holding fleet's machine-local worker metadata. |
| `FLEET_SPAWN_TIMEOUT_MS` | `120000` | Maximum milliseconds to wait for a fresh worker's named, input-ready omp startup; herdr clamps it to 300000. |
| `FLEET_WAIT_TIMEOUT_MS` | `3600000` | Maximum milliseconds for one `fleet ask` or `fleet join`. |
| `FLEET_DISPATCH_SETTLE_MS` | `15000` | Maximum milliseconds to verify that a dispatched prompt reached the expected worker state. |
| `FLEET_EDITOR` | `nvim` | Editor command run beside the agent in the `full` layout. |
| `FLEET_GIT_UI` | `lazygit` | Git UI command run beside the agent in the `full` layout. |
| `FLEET_LAYOUT_START_TIMEOUT_MS` | `15000` | Maximum milliseconds to verify that a layout's requested TUI became foreground before retrying. |
| `FLEET_BOSS_HANDLE` | slugified repository-root name (or `boss` outside a repository) | Overrides the default orchestrator handle claimed by `fleet boss`. |

## Coexistence with workspace-manager

`fleet spawn` checks whether the enabled `herdr-plugin-workspace-manager` has a configured workspace covering the repository. It compares configured path entries by git common directory, expands `~/` paths, and also recognizes a configured bare repository name. If covered, fleet refuses the spawn instead of racing workspace-manager to create or lay out the workspace.

For the agent-facing orchestration commands — the `/fleet:*` slash commands that
dispatch work to these workers — see the companion omp plugin at
[`../plugins/fleet/`](../plugins/fleet/).
