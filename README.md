# Foreman

Foreman is a repo with two Foreman plugins that let one agent act as a project
manager and hand the actual engineering to peer agents running on their own
branches:

- **[`herdr/`](./herdr/)** — a herdr plugin providing the `foreman` CLI: create a
  git worktree, start a separate coding agent in it, dispatch work, collect the
  report.
- **the repo root** — an omp-native agent plugin (`package.json`,
  `.omp-plugin/plugin.json`, `.mcp.json`, `command-prompts/`, `skills/`,
  `extension/`) providing the boss's slash commands, custom tools, and the
  `foreman bus` sidecar.

Both plugins share the name `foreman` with the GitHub repo — coincidence, not
an install-time namespace; there is no marketplace here, so nothing keys an
install on it.

## The idea

omp's `task` subagents share one process: one context window, one working
directory, one lifetime. That is the right tool for work that fits in the
current checkout, and the wrong one for anything that wants a branch.

herdr already has the primitives for the other case — worktrees, panes, named
agents you can address later — and `foreman` is those primitives wired into one
command per dispatch. A worker is a full omp process with its own context
window, sitting in its own worktree, reachable an hour later, and its
deliverable is a branch rather than a message.

This plugin manages the foreman — worktrees, branches, workers, reports — and
nothing else. It has no opinion on *how* a worker does its job and ships no
execution skills of its own. If a worker should follow a particular
procedure — a skill of yours, a house convention, nothing at all — you name
it in the brief, per dispatch, the same way you'd tell a stranger what to do.
Bring your own process.

```mermaid
graph LR
  U[User] <--> B[Boss]
  B -->|"/foreman:dispatch"| W1["worker (omp)<br/>feat/a"]
  B -->|"/foreman:dispatch"| W2["worker (omp)<br/>feat/b"]
  B -->|"/foreman:dispatch"| W3["worker (omp)<br/>fix/c"]
  W1 -->|report| B
  W2 -->|"reply: which retry policy?"| B
  W3 -->|report| B
```

## Requirements

- [herdr](./herdr/) 0.8.0 or newer, and a herdr pane (`HERDR_ENV=1`)
- `jq` on `PATH`
- macOS or Linux

## Install

Both halves are needed: the herdr plugin supplies the mechanism, the agent
plugin supplies the commands, custom tools, and delivery.

```sh
herdr plugin install andyhite/foreman/herdr
```

```sh
omp install github:andyhite/foreman
```

For a local checkout instead of GitHub, either command takes a path:

```sh
herdr plugin link ./herdr
omp install ./
```

Installing the omp plugin registers the `foreman_*` custom tools and declares
the `foreman bus` sidecar in this plugin's own root `.mcp.json`
(`{"command": "foreman", "args": ["bus"]}`). That file, not the
`.omp-plugin/plugin.json` manifest, is what omp actually reads: the
`omp-plugins` capability provider discovers MCP by scanning conventional paths
under each enabled plugin root, and the manifest's `mcpServers` field is
carried as metadata only. Declaring it there instead looks right, type-checks,
and starts nothing — see [AGENTS.md](./AGENTS.md).

The sidecar is therefore plugin-scoped, not machine-global: it exists if and
only if a session has this plugin loaded, and nothing is written outside the
session. A worker's `foreman report`/`foreman reply`, and a boss's dispatch,
signal that sidecar directly with `SIGUSR1`; the sidecar turns the signal into
an MCP notification the extension then delivers. Delivery splits by urgency,
not direction: only a worker's question interrupts, because only a question
leaves someone blocked waiting on the answer. A worker's report, a task the
boss dispatches, and a `foreman msg` either way all queue for the receiver's
next turn boundary — a worker interrupted mid-change is the thing foreman
exists to avoid, and finished work can wait. The interrupting payload carries
its own handling protocol (log it, finish the current step, then act), so an
interruption cannot read as *drop everything*. If the signal can't be
delivered — no live sidecar, or the target pane sits outside herdr — delivery
falls back to an interrupting `herdr agent prompt` for everything, so nothing
is silently lost; only the queued direction is degraded. A ~60s background
sweep in the extension is the remaining anomaly
net, for a worker that ended its turn without reporting or whose agent died.
Restart the session after either install; `/mcp reconnect`
is not enough, since extension modules load only at startup.

`herdr/bin/foreman-link` no longer writes anything to
`~/.omp/agent/mcp.json`, and removes the entry an older version of it left
there — one machine-wide sidecar per session, in sessions that never loaded
this plugin and so could never turn a wake into an aside.

## Use

Once per project, before the first `/foreman:boss`:

```
/foreman:init
```

Creates `.foreman/config.yml` if it doesn't exist yet, then digs through the
repo — its documented conventions and whatever skills it can find, both its
own and this session's — to propose a starting `roles:` mapping, and matches
role names against any `modelRoles:` already configured, globally or for
this project, to pin one where the alias already exists. Safe to re-run;
it never overwrites a mapping already there.

```
/foreman:boss Ship the webhook retry work in #412 and #413
```

That claims a boss handle for the pane and adopts the role. From
there the boss talks to you, slices the objective, and dispatches
each slice:

```
/foreman:dispatch Add exponential backoff to the webhook dispatcher.
Tests in tests/webhooks/. Do not change the public dispatch() signature.
```

Every dispatch does the same three things: check that the requirements are
precise enough to hand to a stranger, write a brief to a file, and dispatch
a worker with the `foreman_spawn` tool. It takes the whole brief as its
`task` field and writes it to a temp file itself, so no shell quoting can
mangle a multi-line brief — that is why it leads over the CLI form. Outside
an omp session with the extension loaded, `foreman spawn` on the CLI is the
fallback, and the spawn is always this shape:

```bash
foreman spawn <branch> --tier <standard|deep> \
  [--role <name>] [--skill <name> ...] --task-file <brief>
```

`--role` is optional and appears at most once. It resolves through `roles:` in
foreman's config (`foreman roles` shows the mapping) to one skill instruction,
and may also default `--tier`/`--model` when the role's config value carries
a model token (`review: code-review @review`) — an explicit `--tier`/`--model`
at the call site still wins. Use it for a named convention, such as `review`,
whose mapped skill or model may change without rewriting every dispatch.
`--skill <name>` is repeatable; each named skill prepends `Before doing any
other work, read skill://<name> and follow it.` to the worker prompt, in flag
order. When both are present, the role-mapped instruction comes first, then
every literal skill instruction.
Leave both absent and the worker gets the brief alone. Foreman then appends its
protocol block telling the worker how to commit, file its report, stay in its
worktree, and interrupt the boss with a question. Briefs repeat none
of those instructions.

## Invocation control

`skills/*/SKILL.md` are auto-discovered through omp's conventional plugin
scanning; `user-invocable: false` keeps `foreman-boss`, `foreman-worker`,
and `foreman-dispatch` out of the bare `/foreman` slot — that namespace is noise
once `foreman:<name>` commands exist — while staying reachable to a model, and
to any session through `skill://<name>`, which reads the file directly and
ignores the flag.

`extension/index.ts` reads `command-prompts/*.md` at load and registers each
directly as `foreman:<name>` — see [Install](#install) for why. `boss` and
`dispatch` create a branch, a worktree, and a live agent process; `init`
writes a project config file. All three are side effects a user asks for,
never ones a model decides on its own, which is what registering them
directly — rather than through any auto-discovery path — guarantees; there is
no frontmatter flag to set on that side, only the skills need one.

## Skills

- `skill://foreman-dispatch` — the boss/worker split and brief shape
- `skill://foreman-boss` — spawning, joining, replying, reporting, and reaping
- `skill://foreman-worker` — reporting, asking a blocked question, and peer messaging from a worker

Details: [`herdr/README.md`](./herdr/README.md) for the CLI.
