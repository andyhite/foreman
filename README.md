# Foreman

[![CI](https://github.com/andyhite/foreman/actions/workflows/ci.yml/badge.svg)](https://github.com/andyhite/foreman/actions/workflows/ci.yml)

An [omp](https://github.com/andyhite/oh-my-pi) plugin that runs a single-operator
agile SDLC over [Linear](https://linear.app). Agents move issues one state to the
right; you approve what they propose.

Foreman keeps no database. Linear is the state machine, the queue, and the audit
log. Every decision an agent makes lands as a Linear mutation or a comment, so
the board you already look at is the whole system state.

## The shape of it

```mermaid
flowchart LR
    T[Triage] -->|foreman-triage| B[Backlog]
    T -->|foreman-triage| X[Canceled / Duplicate]
    B -->|foreman-refine| R[Todo]
    R -->|claim at dispatch| P[In Progress]
    P -->|foreman-implement| V[In Review]
    V -->|foreman-review| D[Done]
    V -->|foreman-review| P
```

Four workflow agents, each responsible for exactly one edge. None of them can
spawn another agent, and none of them can write to Linear — the `task` tool and
Linear's mutation API are both withheld. An agent returns a validated structured
result; the extension performs the mutation. That split is the design.

| Agent | Edge | Model | Produces |
| --- | --- | --- | --- |
| `foreman-triage` | Triage → Backlog / Canceled / Duplicate | `@smol` | A priority, a `type:` label, dedupe findings |
| `foreman-refine` | Backlog → Todo | session | Acceptance criteria, a Fibonacci estimate, a split proposal |
| `foreman-implement` | In Progress → In Review | session | A branch, tests, a PR, per-criterion evidence |
| `foreman-review` | In Review → Done / In Progress | `@slow` | Findings by severity against the diff |

An agent that cannot proceed does not guess and does not stall. It yields a
`BlockRecord` naming the question and the options, which becomes a `blocked:`
label and an entry in the drain you resolve with one keypress.

## Install

Requires [Bun](https://bun.sh) 1.3+, `git`, `gh` authenticated for the repos
Foreman will open PRs against, and [omp](https://github.com/andyhite/oh-my-pi).
Foreman isn't published as a standalone package, so getting the CLI still means
a one-time clone-and-build — after that, `foreman setup` registers the plugin
straight from GitHub and none of your other repos need this checkout again.

The one-line installer clones the checkout to `~/.foreman/src`, builds it,
drops a `foreman` wrapper on `$PATH` (`~/.local/bin` by default), and launches
`foreman setup`:

```bash
curl -fsSL https://raw.githubusercontent.com/andyhite/foreman/main/scripts/install.sh | bash
```

It's re-runnable — running it again pulls the latest checkout and re-runs
setup on top of your existing `~/.foreman/config.json`. Extra arguments pass
straight through to `foreman setup`, e.g.
`... | bash -s -- --yes --omp install --scope user`. Prefer to do it by hand:

```bash
git clone https://github.com/andyhite/foreman
cd foreman
bun install && bun run build
bun run packages/cli/dist/main.js setup --yes --omp install --scope user
```

`foreman setup` (alias `init`) is the installer: it checks for `bun`/`git`/`gh`/
`omp`/`herdr`, walks you through `~/.foreman/config.json`, then installs the
plugin(s) you choose. If `$LINEAR_API_KEY` is already set, setup skips the key
prompt entirely and uses it straight away to list every product (initiative)
in your Linear workspace as a checkbox picker (`↑`/`↓` to move, `space` to
toggle, `enter` to confirm) — pre-checking any product already mapped in your
config, and guessing a repo path for each newly-picked product by matching
its name against git checkouts in nearby directories (a sibling of this
checkout, `~/Code`, `~/dev`, and similar). You still confirm or edit every
guess before it's written; without a key (or without network access to
Linear), setup falls back to typing initiative ids and paths by hand.
`--omp install` (shown above) is the production path — it registers the omp
plugin from `andyhite/foreman` on GitHub rather than linking back to this
checkout. Drop `--yes` to be walked through the config interactively instead:

`--scope user` (the default) installs the omp plugin across every repo you
work in; `--scope project` scopes it to the current repo. The herdr board is
optional — add `--herdr install` to register it too, or answer its prompt.
Run `setup --help` for the full flag list, including `--repo-source` to point
at a fork. `setup` without `--yes` is equivalent to running these by hand:

```bash
omp plugin marketplace add andyhite/foreman
omp plugin install foreman@foreman --scope user
```

Point Foreman at Linear and at least one repo in `~/.foreman/config.json` —
`setup` prompts for this, or edit it directly:

```json
{
  "repos": {
    "a1b2c3d4-0000-0000-0000-000000000000": "~/Code/my-app"
  },
  "linear": {
    "teamKeys": ["ENG"]
  }
}
```

Foreman reads the Linear personal API key from `$LINEAR_API_KEY`, or from
`linear.apiKeyFile` when the env var is unset — `foreman setup` writes that file
for you (mode `0600`) if you paste a key during the prompt. The `repos` map,
keyed by initiative ID, is the only place Foreman learns which repo a product
belongs to; an issue whose project has no initiative, or whose initiative
isn't in the map, is skipped rather than guessed at.

Once installed, day-to-day use is `foreman loop` (below) and the `/foreman:*`
slash commands inside any omp session. See [Development](#development) below
if you want to hack on Foreman itself instead of just running it.

## Running the loop

The supervisor polls Linear and dispatches whatever the gates allow.

```bash
foreman loop --dry-run --once --verbose   # decide and log, dispatch nothing
foreman loop --stage read-only            # comment and label, no code
foreman loop --stage full                 # the whole pipeline
```

`loop.stage` defaults to `dry-run`, so a loop started before you are ready logs
its intentions instead of acting on them. A dry run prints one line per skip with
the gate that refused:

```
[foreman-loop] refine: 0 dispatched, 43 skipped
[foreman-loop]   skip refine PLT-21: unprioritized — Priority is None.
[foreman-loop]   skip triage (batch): before-triage-window — Before the 06:00 triage window.
```

The `foreman-loop` prefix names the long-lived process, not the command — the
same spelling herdr uses for its pane. The loop is a singleton: a second one
refuses to start while the first holds the lock.

## Operator surface

Slash commands, inside any omp session:

| Command | Does |
| --- | --- |
| `/foreman:status` | Board state, WIP, backpressure, last run per worker |
| `/foreman:apply` | Review staged proposals; `--yes` to execute the batch |
| `/foreman:apply ENG-1 --approve` | Accept one proposal |
| `/foreman:apply ENG-1 --reject <reason>` | Reject one, with the reason recorded |
| `/foreman:merge` | Merge what is mergeable, then move issues to Done |
| `/foreman:unblock ENG-1 <reply>` | Answer a `BlockRecord` and release the issue |

Four dispatch commands run one agent by hand: `/foreman:triage`,
`/foreman:refine`, `/foreman:implement`, `/foreman:review`.

If you use [herdr](https://github.com/andyhite/herdr), the board ships as a
plugin with four screens — the blocked drain, proposal review, the board, and
live agent detail. Requires herdr 0.8.0 or newer. `foreman setup --herdr install`
installs it from GitHub; by hand:

```bash
herdr plugin install andyhite/foreman/packages/herdr-plugin
```

(See [Development](#development) for `herdr plugin link` — the dev-mode path.)

Installing registers four actions and, via its `[[startup]]` hook, ensures a
long-lived `foreman-loop` pane in a workspace labelled `foreman` — reusing yours
if you already have one. Bind the screens you want in
`~/.config/herdr/config.toml`; an action is the only thing a keybinding can
address, so each screen is reached through one:

```toml
[[keys.command]]
key = "ctrl+shift+b"
type = "plugin_action"
command = "andyhite.foreman.open-blocked"
description = "Foreman: open the blocked drain"
```

The other three are `open-proposals`, `open-board`, and `open-agents`. To run
agents in real panes you can attach to instead of headless children, set
`loop.dispatcher` to `"herdr"`; if the server is unreachable the loop logs a
fallback and continues in print mode rather than stalling.

## Configuration

`~/.foreman/config.json` holds everything; `<repo>/.foreman/config.json` may
override the per-repo keys, versioned alongside the code they govern. Defaults
are chosen so that an empty config is a safe config.

| Key | Default | Meaning |
| --- | --- | --- |
| `loop.stage` | `dry-run` | Autonomy rung: `dry-run`, `read-only`, `full` |
| `loop.wipGlobal` | `3` | Hard cap on concurrent agents |
| `loop.wip` | `1/2/3/2` | Per-stage caps: triage, refine, implement, review |
| `loop.backpressureThreshold` | `5` | Blocked depth at which all dispatch stops |
| `loop.readyBufferTarget` | `5` | How deep refine keeps the Todo buffer |
| `loop.reviewCycleCap` | `2` | Review round trips before it escalates to you |
| `loop.triageWindow` | `06:00` | When the daily triage batch may start |
| `loop.cadenceMinutes` | `5` | Poll interval |
| `repoDefaults.pr.required` | `true` | Open a PR rather than pushing to the base branch |
| `repoDefaults.merge.strategy` | `squash` | `merge`, `squash`, or `rebase` |
| `agent.maxRuntimeMs` | `7200000` | Mirrors omp's cap; the lock TTL derives from it |

Config tunes parameters. It never removes an invariant: there is no key that
disables a gate, a WIP limit, backpressure, the lock protocol, or
propose-before-apply.

## Labels

Foreman reads and writes a small vocabulary, and every label in it is consumed by
a gate or a worker predicate.

- `type:` — `bug`, `feature`, `chore`, `spike`, `docs`. Required to leave Triage.
- `agent:` — `ready`, `running`, `proposed`, `hands-off`. Lifecycle control,
  written only by the extension. `agent:hands-off` is yours: it means no agent
  touches this issue.
- `blocked:` — `needs-input`, `needs-decision`, `external`. The interrupt queue.

## Layout

```
packages/
  core/          Linear client, config, gate validators, lock protocol, schemas
  omp-plugin/    The plugin: agents, skills, commands, rules, extension
  loop/           The supervisor and its six workers
  herdr-plugin/   The board: four TUI panes over the same core
  cli/            The foreman CLI — setup, and delegates `loop` to packages/loop
```

`packages/core` is the single source of truth for every contract. The four agent
output schemas are defined once in TypeBox there and generated into each agent's
frontmatter — CI fails if the two drift.

## Development

Same clone as above, but link instead of install: `foreman setup --omp link`
symlinks `packages/omp-plugin` in place so edits show up without reinstalling,
and `--herdr link` does the same for `packages/herdr-plugin`.

```bash
git clone https://github.com/andyhite/foreman
cd foreman
bun install && bun run build
bun run setup
```

`bun run setup` runs `setup --omp link --herdr link` straight from source
(no prebuilt `@foreman/cli` needed); everything after `setup` still prompts,
so it's the same config walkthrough as the top-level install, just wired to
link both plugins back to this checkout instead of installing from GitHub.

`omp plugin link` and `herdr plugin link` register the checkout but skip its
build step, so every source change needs `bun run build` (or `bun run --filter
'@foreman/omp-plugin' build`/`--filter '@foreman/herdr-plugin' build` for one
package) before `/reload-plugins` or a herdr restart picks it up. `foreman`
itself is a bundled CLI too — rebuild `@foreman/cli` the same way after editing
`packages/cli`, or run it straight from source with `bun run packages/cli/src/main.ts`.

```bash
bun run typecheck   # tsc --build across the workspace
bun test            # 268 tests
bun run contract    # agent/skill/schema wiring check
bun run schemas     # regenerate output schemas into agent frontmatter
bun run check       # all three
```

`bun run contract` catches the failures that are silent at runtime: a tool name
omp does not have, an `autoloadSkills` entry with no matching skill, a skill
shadowed by a higher-priority provider, or a frontmatter schema that has drifted
from its TypeBox definition. None of these produce a warning when omp loads the
plugin; the agent just runs without its procedure.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — the build specification this implements
- [`docs/VERIFIED.md`](docs/VERIFIED.md) — what was measured against the real omp,
  herdr, and Linear APIs during the build, including the four places the spec was
  wrong and what the code does instead
