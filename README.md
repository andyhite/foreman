# omp-foreman

An [omp](https://github.com/oh-my-pi) extension that packages a
GitHub-issue-tracker-driven development workflow — ideas → epics/tasks →
worktrees → TDD implementation → QA gate → (stacked) pull requests →
operator merge — as reusable commands, skills, and agents. It carries no
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
  installed): `init`, `doctor`, `help`, `record`, `groom`, `work <issue>`,
  `orchestrate <epic>`, `report`, `triage`.
- **Skills** (`skills/*/SKILL.md`): `bootstrap` (backs `/foreman:init`),
  `doctor` (backs `/foreman:doctor` — config-drift detection and repair),
  `tracker`, `worktree`, `dev-loop`, `epic-loop`, `grooming`, `bug-triage`,
  `verification`, `stacked-prs`.
- **Agents** (`agents/*.md`): `planner`, `qa`, `issue-worker`.
- **Rules** (`rules/*.md`): five tool-call interrupts for the workflow's own
  sharp edges — pushing at the main branch, closing issues by hand, worktree
  discipline, the obligations that come with opening a PR, and keeping the
  todo list synced to real landings (PR merges, issue closes, worktree
  cleanup). These are the enforcement half of the skills above, so they ship
  with foreman rather than separately.

## Rule packs in this marketplace

Everything that *doesn't* depend on the foreman workflow ships as a
standalone plugin from the same catalog, grouped by concept. Install any
combination — none depends on `foreman` or on any other pack, and
`scripts/check.ts` fails the build if one ever grows a `skill://` or
`/foreman:` reference back into foreman.

**Always safe to install together:**

| Plugin | Rules | Concept |
|---|---|---|
| [`git-hygiene`](plugins/git-hygiene) | `destructive-git`, `force-with-lease`, `main-needs-a-pr`, `default-branch-is-read-only` | Irreversible git operations, and keeping the default branch clean |
| [`verification-integrity`](plugins/verification-integrity) | `test-integrity`, `hooks-are-the-gate` | Don't fake a green build |
| [`generated-files`](plugins/generated-files) | 4 path rules | Don't hand-edit machine-generated output |
| [`shell-safety`](plugins/shell-safety) | 5 rules | Irreversible or over-privileged shell commands |
| [`secrets-hygiene`](plugins/secrets-hygiene) | 4 rules | Credentials out of the repo and out of transcripts |

**Pick exactly one per ecosystem** — each pack asserts that *its* tool is the
package manager, so two of them will fire on each other's correct commands:

| Plugin | For repos using |
|---|---|
| [`pnpm-hygiene`](plugins/pnpm-hygiene) | pnpm |
| [`npm-hygiene`](plugins/npm-hygiene) | npm |
| [`yarn-hygiene`](plugins/yarn-hygiene) | yarn (Classic and Berry) |
| [`bun-hygiene`](plugins/bun-hygiene) | bun |
| [`uv-hygiene`](plugins/uv-hygiene) | uv (Python) |
| [`pip-hygiene`](plugins/pip-hygiene) | pip + virtualenv (Python) |
| [`cargo-hygiene`](plugins/cargo-hygiene) | cargo (Rust) |

Each pack carries a wrong-tool rule (`pnpm-only`, `npm-only`, …) naming the
right idiom for every competing command, a path rule protecting its lockfile,
and the tool's specific escape hatches (`--no-frozen-lockfile`,
`--legacy-peer-deps`, `--break-system-packages`, `--cap-lints allow`).
Because these are per-project choices, install them with `--scope project`:

```sh
omp plugin install --scope project pnpm-hygiene@omp-foreman
omp plugin install git-hygiene@omp-foreman
omp plugin install shell-safety@omp-foreman
```

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
/foreman:record ...   # capture an idea
/foreman:groom        # turn ideas into task/epic issues, or reject them
/foreman:work <n>     # deliver a task or bug end to end
/foreman:orchestrate <n>  # deliver an epic via issue-worker subagents
/foreman:report       # board snapshot
/foreman:triage ...   # file/triage a bug with a severity label
```

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
- **The operator always merges.** Every skill and agent treats "the
  operator merges the PR" as the approval and "the operator commented on
  the PR" as a change request — no agent merges on its own judgment.
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
    "bugSeverities": ["sev0", "sev1", "sev2", "sev3"]
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
  "epicLoop": {
    "maxConcurrentTracks": 3
  }
}
```

- `mainBranch`, `commitTypes`, `commands.*`, and `board.statuses.<role>.name`
  are **detected** by `/foreman:init` from this repo's own commitlint
  config, lockfile, `package.json` scripts, and existing board — never
  invented. Anything undetectable is left `null`/a documented default and
  called out as a guess in the init report, not silently assumed.
  `board.statuses` maps foreman's six semantic roles onto whatever this
  repo's board actually calls those columns, so a board that predates
  foreman doesn't need to be renamed to fit it.
- `epicLoop.maxConcurrentTracks` is a starting default (3), not a detected
  value — tune it to the project's review bandwidth.
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
