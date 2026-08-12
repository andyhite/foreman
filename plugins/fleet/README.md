# Fleet (agent plugin)

omp-native orchestrator commands and tools — one of the two Fleet plugins the
Foreman marketplace publishes. This plugin supplies the orchestrator's
`/fleet:*` commands and `fleet_*` custom tools; the companion
[herdr plugin](../../herdr/) supplies the `fleet` CLI those commands and tools
drive. Together they turn an agent session into a project manager: keep
interactive requirements work with the user, then dispatch autonomous
execution to separate coding-agent processes in herdr worktrees.

The orchestrator and every worker it spawns are always omp.

## Why

The mattpocock skills split cleanly along a line that nobody usually draws:
some need the user in the room, while others just need a checkout.

`grill-me`, `to-spec`, `to-tickets`, `triage`, and `wayfinder` are interviews
and backlog work. `implement`, `diagnosing-bugs`, `research`, `prototype`, and
`code-review` are autonomous, run long, and each want a branch to themselves.

Fleet keeps the interactive half with you and sends the autonomous half to
separate agent processes, one per branch, running in parallel.

## Requirements

- [Fleet's herdr plugin](../../herdr/), which puts `fleet` on `PATH`
- [mattpocock/skills](https://github.com/mattpocock/skills) installed in a
  standard omp Agent Skills root
- An agent session running inside a herdr pane (`HERDR_ENV=1`)

Skills resolve through omp's native `skill://<name>` reference — the system
prompt already instructs reading it, and discovery covers the project, user,
and installed-plugin skill roots, so both the mattpocock workflow skills and
this plugin's own skills resolve in every session.

`/fleet:backlog` reads `docs/agents/issue-tracker.md` and cannot run without
it. Read `skill://setup-matt-pocock-skills` once per repo to create it.

## Install

The plugin ships one `commands/` tree, one `skills/` tree, and an extension
module that registers the `fleet_*` custom tools.

```text
/marketplace add andyhite/foreman
/marketplace install fleet@foreman
```

Restart the session after installing — omp loads extension modules and the
tools they register at startup rather than mid-session.

The marketplace is named `foreman` after the repository that publishes it; the
plugin inside it keeps the name `fleet`, so the install target reads
`fleet@foreman`.

## Commands

Start here. It claims the orchestrator handle and defines the role:

```text
/fleet:boss <objective>
```

Then dispatch one command per kind of work:

| Command | Worker skill | For |
|---|---|---|
| `/fleet:implement` | `implement` | building a spec or set of tickets |
| `/fleet:diagnosing-bugs` | `diagnosing-bugs` | a bug or performance regression |
| `/fleet:research` | `research` | a question needing primary sources |
| `/fleet:prototype` | `prototype` | a design question needing something runnable |
| `/fleet:code-review` | `code-review` | reviewing a branch a worker already produced |

`/fleet:backlog` walks the tracker's dependency graph, dispatches every ready
ticket to its matching skill, sends every branch that comes back to a
`code-review` worker, merges what passes, recomputes the frontier, and repeats.
It is the only command that merges; per-ticket commands stop when their worker
reports.

The `/fleet:` prefix namespaces plugin commands as `<plugin>:<command>` in omp.

Every dispatch command does the same three things: check that you can state
the requirements precisely, write a brief to a file, and dispatch a worker
against it (the `fleet_spawn` tool, or `fleet spawn` on the CLI — they are the
same operation). What differs is *which* requirements that skill cannot
proceed without — the seams the `tdd` skill will test at, the reproduction
steps a feedback loop needs, the fixed point a review diffs against. Each
command asks for its own; `/fleet:backlog` asks for a whole wave's worth in
one round.

The spawn is always this shape:

```bash
fleet spawn <branch> --tier <standard|deep> \
  --skill <execution-skill> --task-file <brief>
```

`--skill` prepends one universal instruction:

```text
Before doing any other work, read `skill://<name>` and follow it.
```

There is one invocation path for every worker, because every worker is omp:
no per-kind syntax to keep in sync.

Fleet then appends its protocol block telling the worker how to commit, file its
report, stay in its worktree, and interrupt the orchestrator with a question.
Briefs repeat neither the skill instruction nor the protocol.

## Invocation control

omp loads `commands/` and `skills/` through the same machinery, so both are
invocable from both sides unless the frontmatter says otherwise. The two
halves of this plugin want opposite defaults:

| File | Frontmatter | User | Model |
|---|---|---|---|
| `commands/*.md` | `disable-model-invocation: true` | yes | no |
| `skills/*/SKILL.md` | `user-invocable: false` | no | yes |

A dispatch command creates a branch, a worktree, and a live agent process. That
is a side effect a user asks for, never one a model should decide on its own, so
every command opts out of model invocation.

The two skills are the opposite: contract documents, meant to be read. `fleet`
would otherwise bind bare `/fleet` beside the `fleet:` command namespace, which
is noise, so they opt out of user invocation and stay reachable to a model —
and to any session through `skill://fleet`, which reads the file directly and
ignores both fields.

omp treats unrecognised frontmatter keys as metadata, so neither field changes
anything there.

## Skills

- `skill://fleet-dispatch` — the orchestrator/worker split and brief shape
- `skill://fleet` — spawning, joining, replying, reporting, and reaping

## How dispatch actually works

A worker is a blank agent process whose first input is the brief, opening with
the line `--skill` prepends:

```text
Before doing any other work, read `skill://implement` and follow it.
```

That instruction line is what makes dispatch reliable: naming the skill
explicitly guarantees the worker works from *that* skill's own procedure,
rather than trusting a blank agent to auto-select the right one out of a list
of forty. `fleet` then appends its own protocol block telling the worker how
to commit, how to file its report, and how to interrupt you with a question,
so briefs never repeat any of it.

`disable-model-invocation: true` is the reason a brief names its skill instead
of trusting a menu — `skill://fleet-dispatch` covers which skills set it and
why that lands on the orchestrator more than the worker.
