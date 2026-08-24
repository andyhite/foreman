# Foreman

Foreman is a repo with two Foreman plugins that let one agent act as a project
manager and hand the actual engineering to peer agents running on their own
branches:

- **[`herdr/`](./herdr/)** — a herdr plugin providing the `foreman` CLI: create a
  git worktree, start a separate coding agent in it, dispatch work, collect the
  report.
- **the repo root** — an omp-native agent plugin (`package.json`,
  `.omp-plugin/plugin.json`, `command-prompts/`, `skills/`, `extension/`)
  providing the boss's slash commands and custom tools.

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
plugin supplies the commands and custom tools.

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

Installing the omp plugin also registers the `foreman_*` custom tools. Restart
the session afterward — omp loads extension modules at startup, not
mid-session.

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
a worker against it (the `foreman_spawn` tool, or `foreman spawn` on the CLI —
they are the same operation). The spawn is always this shape:

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
