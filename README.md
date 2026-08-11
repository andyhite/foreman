# omp-foreman

An [omp](https://github.com/oh-my-pi) extension that packages a
GitHub-issue-tracker-driven development workflow — ideas → epics/tasks →
worktrees → TDD implementation → QA gate → (stacked) pull requests →
operator merge by default — as reusable commands, skills, and agents. It carries no
hardcoded repo, org, or tech stack: every project-specific constant (repo,
GitHub Projects v2 board, label vocabulary, commit-type set, package
manager, check/verify/e2e commands) is resolved once by `/foreman:init`
and read back out of `.omp/foreman.json`.

**Naming:** the *repo* is `omp-foreman`, but the *plugin* it installs is
named plain `foreman` (`package.json#name`) — the two don't have to match.
omp automatically prefixes every command from an installed plugin with the
plugin's own name (not the repo it came from), so once installed
(`omp plugin link`/`omp plugin install`, below) commands are invoked as
`/foreman:init`, `/foreman:help`, etc. — short, ergonomic, and consistent
with the skill/agent names and the `.omp/foreman.json` config file, none of
which are namespaced by omp at all. The repo keeps the longer
`omp-foreman` name so it doesn't collide with the unrelated `foreman`
process manager if this ever needs a public, unambiguous identity (a repo
URL, a published package) — that pressure doesn't apply to the plugin name
itself, which only has to be unique among *your* installed plugins.
Loading the extension directly with `--extension` (no plugin wrapper, no
`package.json` in play) also exposes the bare command names with no
prefix — same as the plugin path here, since the plugin name already is
`foreman`.

This is the generalized, project-agnostic form of a workflow originally
built inside one specific repo; if you're looking at both side by side,
this one is the reusable half.

## What it gives you

- **Commands** (`commands/*.md`, invoked as `/foreman:<name>` once
  installed): `init`, `doctor`, `help`, `intake`, `record`, `groom`, `chart`,
  `work <issue>`, `orchestrate [epic]`, `report`, `triage`.
- **Skills** (`skills/*/SKILL.md`): `bootstrap` (backs `/foreman:init`),
  `doctor` (backs `/foreman:doctor` — config-drift detection and repair),
  `prd-intake`, `tracker`, `worktree`, `dev-loop`, `epic-loop`, `grooming`,
  `charting`, `bug-triage`, `verification`, `stacked-prs`.
- **Agents** (`agents/*.md`): `planner`, `qa`, `issue-worker`.
- **Rules** (`rules/*.md`): five tool-call interrupts for the workflow's own
  sharp edges — pushing at the main branch, closing issues by hand, worktree
  discipline, the obligations that come with opening a PR, and keeping the
  todo list synced to real landings (PR merges, issue closes, worktree
  cleanup). They restate the skills above at the moment of the tool call,
  where a skill that was never read can't help, so they ship with foreman
  rather than separately.

## Plugins in this marketplace

Everything that *doesn't* depend on the foreman workflow ships as its own
plugin from the same catalog. Pick the ones you want — none depends on
`foreman` or on any other, and `scripts/check.ts` fails the build if one ever
grows a `skill://` or `/foreman:` reference back into foreman.

[`craft`](plugins/craft) is the tracker-independent reference-skill
pack. It is neither a concept pack nor a tool pack: it is the one pack
`foreman` actually requires, and that edge runs one way only — craft
never references foreman. `/foreman:init` installs it at project scope
and records it in `plugins.packs`; `/foreman:doctor` reports a missing
copy as a broken install, not an optional recommendation.

**Concept packs** — general discipline, safe in any repo, safe together:

| Plugin | Rules | Concept |
|---|---|---|
| [`git-hygiene`](plugins/git-hygiene) | 4 | Irreversible git operations, and keeping the default branch clean |
| [`verification-integrity`](plugins/verification-integrity) | 2 | Don't fake a green build |
| [`generated-files`](plugins/generated-files) | 4 | Don't hand-edit machine-generated output |
| [`shell-safety`](plugins/shell-safety) | 5 | Irreversible or over-privileged shell commands |
| [`secrets-hygiene`](plugins/secrets-hygiene) | 4 | Credentials out of the repo and out of transcripts |

**Tool packs** — one per package manager. Install the ones your project uses:

| Plugin | For repos using |
|---|---|
| [`pnpm`](plugins/pnpm) | pnpm |
| [`npm`](plugins/npm) | npm |
| [`yarn`](plugins/yarn) | yarn (Classic and Berry) |
| [`bun`](plugins/bun) | bun |
| [`uv`](plugins/uv) | uv (Python) |
| [`pip`](plugins/pip) | pip + virtualenv (Python) |
| [`cargo`](plugins/cargo) | cargo (Rust) |

Each carries a wrong-tool rule (`pnpm-only`, `npm-only`, …) naming the right
idiom for every competing command, a path rule protecting its lockfile, and
that tool's specific escape hatches (`--no-frozen-lockfile`,
`--legacy-peer-deps`, `--break-system-packages`, `--cap-lints allow`).

```sh
omp plugin install pnpm@omp-foreman
omp plugin install git-hygiene@omp-foreman
omp plugin install shell-safety@omp-foreman
```

A tool pack is named for its tool, not `<tool>-hygiene`, because it's the home
for *everything* about that tool — rules today, and skills or commands as they
get written. Install at most one pack per ecosystem: `pnpm`, `npm`, `yarn`, and
`bun` each assert that their own tool is *the* Node package manager, so a
second one fires on every correct command of the first, and `uv` and `pip`
compete the same way over Python. Packs for *different* ecosystems don't
collide — a Bun frontend with a Rust core installs `bun` and `cargo` together,
and neither fires on the other's commands. If you work across projects with
different managers, install the relevant ones per project (`--scope project`)
rather than globally.

## Install

Pick a scope:

- **This project only** — add to the project's `.omp/config.yml`:

  ```yaml
  extensions:
    - /path/to/omp-foreman
  ```

- **Every project** — add to your user agent config
  (`~/.omp/agent/config.yml`):

  ```yaml
  extensions:
    - /path/to/omp-foreman
  ```

- **As an installable plugin (recommended)** — `omp plugin link
  /path/to/omp-foreman` (local dev; symlinked, edits take effect
  immediately), or from a marketplace catalog: `omp plugin marketplace add
  andyhite/omp-foreman && omp plugin install foreman@omp-foreman` (note
  the `<plugin>@<marketplace>` split — the plugin is `foreman`, the
  marketplace/repo is `omp-foreman`; a marketplace install caches an
  immutable clone, so pull updates with `omp plugin marketplace update
  omp-foreman && omp plugin upgrade foreman@omp-foreman`).

Restart the session (or `/reload-plugins`) after adding it.

## Quick start

```
/foreman:init         # one-time (or repair) setup: labels + project board + .omp/foreman.json
/foreman:doctor       # drift check: labels/board/detected-commands still match reality
/foreman:intake <doc> # turn a document into a reviewed backlog
/foreman:record ...   # capture an idea
/foreman:groom        # turn ideas into task/epic issues, or reject them
/foreman:chart ...    # chart a foggy idea as decision tickets before grooming
/foreman:work <n>     # deliver one task or bug via a dispatched issue-worker
/foreman:orchestrate [n]  # work the board (or one epic) via issue-worker subagents
/foreman:report       # board snapshot
/foreman:triage ...   # file/triage a bug with a severity label
```

A document enters through `/foreman:intake`, single ideas still enter through
`/foreman:record`, and both converge on `/foreman:groom`.

`/foreman:help` explains all of the above (and any single command, skill,
or agent) grounded in the live tree, not from memory.

## Design notes

- **No hardcoded stack.** `verification` detects the project's own
  `package.json` scripts / `Makefile` / monorepo tool / CI config instead
  of assuming pnpm, vitest, or turbo.
- **No hardcoded repo or toolchain convention.** Every skill reads
  `.omp/foreman.json` (written by `/foreman:init`) for the repo, project
  board IDs, label vocabulary, commit types, package manager, and
  check/verify/e2e commands — see below.
- **Mechanisms are configurable; invariants are not.** `policy` selects the
  worktree provider, planner dispatch, TDD enforcement, QA gate, PR strategy,
  and merge policy without making the workflow's guarantees optional. The
  worktree skill is split into a contract plus per-strategy files, so a caller
  names an operation rather than a `git worktree` command; adding a provider
  therefore does not require changing six skills.
- **The workflow ends at the merge.** Releases, changelogs, and version
  bumps are deliberately out of scope: they belong to the repo's own release
  automation (release-please, changesets, a tag-triggered pipeline), which
  runs on what lands rather than per issue — foreman neither assumes one
  exists nor replaces it. The one post-merge path foreman does own is
  regression: a broken release enters as a bug through `/foreman:triage`,
  gets a severity, and rides the same loop as any other issue.
- **Rules advise; the extension enforces exactly one thing.** A rule is a
  prompt-level interrupt — it puts the objection in front of the agent as it
  reaches for the command, and an agent can still argue its way past. The
  main branch is the exception: in a repo that has `.omp/foreman.json`,
  foreman blocks the git mutations a session aims at the configured
  `mainBranch`, including the bare `git push` and the commit made from a
  main checkout that no regex condition can recognize. That guard covers this
  agent's own tool calls and nothing else — a person working in their own
  terminal is unaffected. Branch protection on the remote is a separate,
  optional defence; configure it if you want one, but nothing here assumes
  it exists or leans on it as the backstop.
- **Rules come in three shapes, and the `scope` requirement differs.**
  `scripts/check.ts` enforces all three:
  - A **command rule** has a regex `condition` and an explicit `scope`, which
    must be `"tool:bash"` and never bare `tool` — a bare `tool` scope matches
    every tool call's arguments including `write`/`edit` file *content*, so a
    rule about `git worktree add` would fire while a skill file merely
    documented that command in a code block.
  - A **path rule** has a `condition` that is a YAML sequence of globs and
    **no** `scope`: omp turns a glob-shaped condition into `tool:edit(<glob>)`
    and `tool:write(<glob>)` entries with catch-all condition `.*`. Adding an
    explicit `scope` there is a bug — it keeps the catch-all and fires the
    rule on every command in that scope.
  - A **standing rule** has `alwaysApply: true` and no condition, so its body
    is injected into the system prompt. This is the only shape that can state
    an invariant a regex can't detect — `default-branch-is-read-only` uses it
    because no condition can ask which branch is checked out.
- **Rule names are global.** omp deduplicates rules by name across every
  installed plugin and keeps only the first, so a collision silently disables
  one. Tool-specific rules are prefixed (`pnpm-lockfile`, not `lockfile`) and
  `scripts/check.ts` fails on a duplicate.
- **Required plugins form one-way, acyclic edges.** A plugin may
  declare `omp.requiresPlugins` in its `package.json`.
  `scripts/check.ts` then resolves each `skill://` against that
  plugin's own skills plus the skills of every declared requirement.
  A requirement may point only at a standalone pack, and a standalone
  pack may not declare any requirements itself, so the graph stays
  acyclic rather than growing chains or cycles.

## `.omp/foreman.json`

Written and repaired by `/foreman:init`. Every other skill reads this
instead of assuming a repo, a board, or a toolchain:

```json
{
  "repo": "owner/repo",
  "mainBranch": "main",
  "commitTypes": ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "style", "revert"],
  "labels": {
    "idea": "idea",
    "epic": "epic",
    "task": "task",
    "bug": "bug",
    "bugSeverities": ["sev0", "sev1", "sev2", "sev3"],
    "readyForHuman": "ready-for-human",
    "chart": "chart"
  },
  "board": {
    "owner": "owner",
    "projectNumber": 1,
    "projectNodeId": "PVT_...",
    "statusFieldId": "PVTSSF_...",
    "statuses": {
      "backlog": { "name": "Backlog", "id": "..." },
      "todo": { "name": "To Do", "id": "..." },
      "inProgress": { "name": "In Progress", "id": "..." },
      "review": { "name": "Review", "id": "..." },
      "done": { "name": "Done", "id": "..." },
      "rejected": { "name": "Rejected", "id": "..." }
    }
  },
  "commands": {
    "packageManager": "pnpm",
    "install": "pnpm install",
    "check": "pnpm check --filter={package}",
    "verify": "pnpm verify",
    "e2e": "pnpm --filter @scope/web e2e"
  },
  "docs": {
    "context": "CONTEXT.md",
    "contextMap": null,
    "adr": "docs/adr",
    "prd": "<docs/prd, or null>",
    "outOfScope": ".out-of-scope"
  },
  "policy": {
    "worktree": { "strategy": "git" },
    "plan": { "planner": "non-trivial" },
    "tdd": { "enforcement": "required" },
    "qa": { "gate": "required" },
    "delivery": { "prStrategy": "stacked", "mergePolicy": "operator" },
    "epicLoop": { "maxConcurrentTracks": 3, "dispatch": "subagent" }
  },
  "plugins": {
    "marketplace": "omp-foreman",
    "packs": ["craft", "git-hygiene", "shell-safety", "secrets-hygiene", "pnpm", "cargo"]
  }
}
```

- `mainBranch`, `commitTypes`, `commands.*`, and
  `board.statuses.<role>.name` are **detected** by `/foreman:init`
  from this repo's own commitlint config, lockfiles, `package.json`
  scripts, and existing board — never invented. Anything
  undetectable is left `null`/a documented default and called out as
  a guess in the init report, not silently assumed.
  `board.statuses` maps foreman's six semantic roles onto whatever
  this repo's board actually calls those columns, so a board that
  predates foreman doesn't need to be renamed to fit it.
- `docs.context`, `docs.contextMap`, `docs.adr`, and
  `docs.outOfScope` record the domain-doc layout that already exists.
  `docs.prd` holds PRD coverage ledgers and source snapshots. A `null`
  here is ordinary absence, not a guess or a setup gap:
  `skill://domain-modeling` creates the domain-doc files lazily when the
  first term or decision is worth recording, and `/foreman:intake` creates
  `docs/prd` on its first run and fills `docs.prd` in — neither is
  scaffolded ahead of having something to put in it.
- `labels.readyForHuman` and `labels.chart` are modifier labels. They
  sit alongside an issue's type label: the former reserves a `To Do`
  task for a human, while the latter marks a wayfinding map and its
  decision tickets.
- **Config selects mechanism, never invariants.**

  | Key | Values (default first) | What it selects |
  | --- | --- | --- |
  | `policy.worktree.strategy` | `git` \| `herdr` \| `provided` \| a repo-relative `.md` path | Which worktree mechanism implements the operations. |
  | `policy.plan.planner` | `non-trivial` \| `always` \| `never` | When the `planner` agent is dispatched. `never` still requires a written inline plan — it removes the subagent, not the plan. |
  | `policy.tdd.enforcement` | `required` \| `encouraged` | `required` is test first, watch it fail, then implement. `encouraged` keeps test-first mandatory for new behavior and bug fixes, and leaves refactors/plumbing to judgment. Neither value permits shipping unproven behavior. |
  | `policy.qa.gate` | `required` \| `advisory` \| `off` | `required` loops to `PASS` before the PR opens. `advisory` dispatches QA once and records its verdict on the PR without looping; Spec blockers are still reported. `off` skips dispatch; rung 3 verification remains mandatory. |
  | `policy.delivery.prStrategy` | `stacked` \| `sequential` | How an epic chain ships. `sequential` dispatches plain PRs after the previous one merges; independent tracks are unaffected. |
  | `policy.delivery.mergePolicy` | `operator` \| `agent-on-green` | Whether the operator merges, or the delivering agent merges after green CI, QA `PASS`, and no unresolved operator comment; it never bypasses the PR. |
  | `policy.epicLoop.maxConcurrentTracks` | `3`, or any positive integer | How many orchestration tracks run concurrently — board scope and epic scope share the cap. |
  | `policy.epicLoop.dispatch` | `subagent` \| `fleet` | How orchestration dispatches workers: in-process `issue-worker` subagents, or separate omp processes in herdr worktree workspaces via the operator's `fleet` CLI, with the orchestrating session as fleet boss. `fleet` requires `HERDR_ENV` and `fleet` on `PATH`; `/foreman:init` offers it as the default wherever it can execute. |

  At every setting, work happens on a branch and lands through a PR; the
  issue is claimed on the board before the first edit; one issue has one
  branch and one writer; worktrees are provisioned and retired by the
  orchestrating session, never by the worker inside them; the primary
  checkout is the operator's; changed behavior is proven by something
  observed, not asserted; and a task is not
  done while its worktree exists. `policy.worktree.strategy` also accepts a
  repo-relative `.md` path as an escape hatch when none of the three shipped
  mechanisms fits. Every default reproduces foreman's standing behavior, so
  an untouched block changes nothing.
- `plugins.packs` is what `/foreman:init` concluded this repo needs
  from the packs above, installed at **project scope**. `craft` is
  always included because foreman requires it. The package-manager
  entries are one Node pack plus a pack for every other ecosystem the
  repo has its own lockfile for — the `pnpm` and `cargo` pair above is
  a pnpm workspace with a Rust crate in it, and both belong there.
  `commands.packageManager` names the primary manager, the one whose
  install sets the repo up for `check`/`verify`/`e2e`; it doesn't make
  the others illegitimate. The list records intent, not a mirror of
  omp's install state — that gap lets `/foreman:doctor` catch a missing
  requirement or a repo that migrated package manager while the old
  pack is still installed and firing on every correct command.
- Hand-edit any field at any time; `/foreman:init` re-run is a repair pass
  that fills gaps and never clobbers a value that looks deliberately
  edited.

## Development

This repo is almost entirely markdown, so there's no compiler to catch a
broken cross-reference or a missing frontmatter field. `scripts/check.ts`
does that instead, across every plugin in the catalog — it verifies every
command/skill/agent/rule has its required frontmatter, every `skill://<name>`
and `/foreman:<name>` reference actually resolves, every `plugins/*`
directory is registered in `.omp-plugin/marketplace.json`, and no sibling
plugin references foreman's skills or commands. It also flags rule files that
reintroduce the `scope: tool` false-positive (see Design notes) and command
files that re-bake the plugin's own name prefix (the `foreman:init`
incident).

```sh
bun scripts/check.ts
```

Runs in CI (`.github/workflows/check.yml`) on every push and PR.
