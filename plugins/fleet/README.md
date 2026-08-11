# Fleet (agent plugin)

Harness-portable orchestrator commands — one of the two Fleet plugins the
Foreman marketplace publishes. This plugin supplies the orchestrator's
`/fleet:*` commands; the companion [herdr plugin](../../herdr/) supplies the
`fleet` CLI those commands drive. Together they turn an agent session into a
project manager: keep interactive requirements work with the user, then dispatch
autonomous execution to separate coding-agent processes in herdr worktrees.

The orchestrator and worker harnesses are independent. An omp orchestrator can
run Claude, Codex, Cursor, or any other kind supported by
`herdr agent start --kind`; `fleet spawn --kind <kind>` chooses the worker.

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
  standard Agent Skills root
- An agent session running inside a herdr pane (`HERDR_ENV=1`)

`fleet skill <name>` resolves skills across the standard project and user roots
used by omp, Claude Code, Codex, Cursor, Gemini CLI, Amp, opencode, and pi.
`FLEET_SKILL_PATH` adds colon-separated roots ahead of those defaults.

`/fleet:backlog` reads `docs/agents/issue-tracker.md` and cannot run without it.
Run `fleet skill setup-matt-pocock-skills` once per repo to create it.

## Install

The plugin keeps exactly one shared `commands/` tree and one shared `skills/`
tree. Tiny manifests adapt that same content to each plugin loader.

### omp

```text
/marketplace add andyhite/foreman
/marketplace install fleet@foreman
```

### Claude Code

```text
/plugin marketplace add andyhite/foreman
/plugin install fleet@foreman
```

Verified by installing this tree from a local checkout with
`claude plugin marketplace add` and `claude plugin install`.

### Codex

```bash
codex plugin marketplace add andyhite/foreman
codex plugin add fleet@foreman
```

Verified that Codex has no catalog of its own here: it falls back to
`.claude-plugin/marketplace.json` and resolves the plugin from that entry, so
the two harnesses install from one catalog.

The marketplace is named `foreman` after the repository that publishes it; the
plugin inside it keeps the name `fleet`, so the install target reads
`fleet@foreman`.

That catalog's entry is `"source": "./plugins/fleet"` — a path from the
repository root, with no `pluginRoot`. `.omp-plugin/marketplace.json` keeps
omp's `pluginRoot` form, which omp documents and which is already in use. The
shapes differ because each is the one verified against its own loader; do not
unify them without re-running both installs.

### Cursor

`.cursor-plugin/plugin.json` is included beside the shared content, matching the
manifest shape Cursor uses. **Untested** — no Cursor install was exercised, and
no Cursor catalog is published here.

### Gemini CLI, Amp, opencode, and pi

These are supported immediately as **worker** kinds through `fleet spawn
--kind`. Their orchestrator-side command packaging still needs a small discovery
adapter; do not copy the command prose. The adapter should link this directory's
shared commands and skills into the harness's native discovery roots.

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

The `/fleet:` prefix works on omp and Claude Code alike: both namespace plugin
commands as `<plugin>:<command>`, and Claude Code reaches them *only* that way —
bare `/boss` is an unknown command there.

Do not infer names from `claude plugin details`. It reports every command and
skill under one "Skills" heading with bare names, which is a display label, not
the invocation.

Every dispatch command does the same three things: check that you can state
the requirements precisely, write a brief to a file, and `fleet spawn` a
worker against it. What differs is *which* requirements that skill cannot
proceed without — the seams the `tdd` skill will test at, the reproduction
steps a feedback loop needs, the fixed point a review diffs against. Each
command asks for its own; `/fleet:backlog` asks for a whole wave's worth in
one round.

The spawn is always this shape:

```bash
fleet spawn <branch> --kind <worker-harness> --skill <execution-skill> \
  --task-file <brief>
```

`--skill` prepends one universal instruction:

```text
Before doing any other work, run `fleet skill <name>` and follow the instructions it prints.
```

There is no per-harness invocation table. The same path is used for every
worker kind, so adding a herdr agent kind cannot silently fall back to generic
agent behavior because its native skill syntax changed.

Fleet then appends its protocol block telling the worker how to commit, file its
report, stay in its worktree, and interrupt the orchestrator with a question.
Briefs repeat neither the skill instruction nor the protocol.

## Invocation control

Claude Code loads `commands/` and `skills/` through the same machinery, so both
are invocable from both sides unless the frontmatter says otherwise. The two
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
is noise, so they opt out of user invocation and stay reachable to a model — and
to any harness through `fleet skill <name>`, which reads the files directly and
ignores both fields.

omp treats unrecognised frontmatter keys as metadata, so neither field changes
anything there.

## Skills

- `fleet skill fleet-dispatch` — the orchestrator/worker split and brief shape
- `fleet skill fleet` — spawning, joining, replying, reporting, and reaping

## How dispatch actually works

A worker is a blank agent process whose first input is the brief, opening with
the line `--skill` prepends:

```text
Before doing any other work, run `fleet skill implement` and follow the instructions it prints.
```

That instruction line is what makes dispatch reliable: naming the skill
explicitly guarantees the worker works from *that* skill's own procedure,
rather than trusting a blank agent to auto-select the right one out of a list
of forty. `fleet` then appends its own protocol block telling the worker how
to commit, how to file its report, and how to interrupt you with a question,
so briefs never repeat any of it.

`disable-model-invocation: true` is the reason a brief names its skill instead
of trusting a menu — `fleet skill fleet-dispatch` covers which skills set it
and why that lands on the orchestrator more than the worker.
