---
name: bootstrap
description: Setting up GitHub issue tracking for a repo under the foreman workflow — repo check, label vocabulary, a GitHub Projects v2 board with a Status field, and detecting this repo's own conventions (main branch, commit types, package manager, check/verify/e2e commands) into .omp/foreman.json. Read when running /foreman:init or repairing a project's tracker config.
---

# Bootstrap — wire a repo into the foreman workflow

Every other foreman skill (`tracker`, `worktree`, `dev-loop`, `epic-loop`,
`grooming`, `bug-triage`, `verification`, `stacked-prs`) reads its constants
from `.omp/foreman.json` at the repo root. This skill is how that file gets
created, or repaired — it is what `/foreman:init` runs.

The philosophy: **detect what's detectable, ask what's ambiguous, never
guess silently.** Nothing here invents a convention the repo doesn't
already have; it finds the repo's actual convention and records it once so
every other skill stops re-deriving it. `verification` still detects
tooling live at check-time as its primary mechanism (a config value can go
stale); what bootstrap writes to `.omp/foreman.json#commands` is a cache
that skips repeated detection and gives you a place to hand-correct
anything the detector guessed wrong.

Idempotent throughout: re-running it against an already-wired repo should
find everything and change nothing, not create duplicates.

## 0. Preconditions

- `gh auth status` succeeds — fail loudly and stop otherwise; everything
  below needs it. If more than one `gh` account is authenticated and the
  wrong one is active, say so before proceeding rather than guessing.
- The current directory is a git repo with a GitHub remote:
  `gh repo view --json nameWithOwner,defaultBranchRef`. If there's no
  remote yet, ask whether to create one (`gh repo create <name>
  --source=. --push`) or point at an existing one — never guess a repo
  name or silently create one without asking.

## 1. Labels

Check what already exists first (`gh label list --json name,color`), then
create only what's missing:

| Label                                          | Color (suggestion)                   | Meaning                                         |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `idea`                                          | `c5def5`                              | Recorded intention, minimal detail              |
| `epic`                                          | `5319e7`                              | Large multi-task effort, broken into sub-issues |
| `task`                                          | `0e8a16`                              | Small, directly actionable unit                 |
| `bug`                                           | `d73a4a`                              | Untriaged bug report                            |
| `bug:sev0`, `bug:sev1`, `bug:sev2`, `bug:sev3` | shades of `d73a4a`, darkest = `sev0` | Triaged bug — severity rubric in `bug-triage`   |

```sh
gh label create idea --color c5def5 --description "Recorded intention, minimal detail" --force
# repeat per row — --force updates color/description on an existing label
# instead of erroring, so this loop is safe to re-run
```

If the project wants a different label vocabulary (different names, more or
fewer severities), don't fight these defaults into shape — create what the
project actually wants and record the mapping in `labels` below. Every
other skill reads the config, never a hardcoded list.

## 2. GitHub Projects v2 board

Check for an existing project first — don't create a second board for a
repo that already has one:

```sh
gh project list --owner <owner> --format json --jq '.projects[] | {number,title,id}'
```

If none is a good fit, create one (ask first if it's ambiguous which repo
this board is for):

```sh
gh project create --owner <owner> --title "<repo> board"
```

Resolve its node ID and number either way (`gh project list` above, or the
`create` output).

### The Status field

```sh
gh project field-list <number> --owner <owner> --format json
```

Look for a single-select field named `Status`. If it doesn't exist, create
it with exactly these six options (their order sets the board's default
column order, not their IDs):

```sh
gh project field-create <number> --owner <owner> --name Status \
  --data-type SINGLE_SELECT \
  --single-select-options "Backlog,To Do,In Progress,Review,Done,Rejected"
```

If a `Status` field already exists with **different option names** (e.g.
`Todo`/`Doing`/`In Review` instead of `To Do`/`In Progress`/`Review`), don't
replace it — map the workflow's six semantic roles onto whatever exists.
Ask the operator only when the mapping is genuinely ambiguous (e.g. two
options that could both plausibly be "in progress"). If a role has no
matching option at all, add it via the GraphQL `updateProjectV2Field`
mutation while carrying over every existing option's `id` unchanged (only
appending the new one — see Hazards).

Record every option's `id`: `gh project field-list <number> --owner <owner>
--format json` returns each field's `options[].{name,id}`.

## 3. Detect the repo's own conventions

Everything in this section is **detected, then confirmed** — never invented.
Where detection is inconclusive, write your best guess and say plainly in
the final report that it's a guess, rather than silently picking one.

### Main branch

```sh
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
```

### Commit types

Look for a commitlint config (`commitlint.config.*`, a `commitlint` key in
`package.json`) or an equivalent conventional-commit enforcement config for
this repo's language. If one exists, extract its allowed `type-enum`. If
none exists, fall back to the Conventional Commits default set (`feat fix
docs refactor perf test build ci chore style revert`) and note in the
report that nothing enforces it.

### Package manager and install command

Detect from the lockfile present at the repo root (first match wins):

| Lockfile                          | Package manager | Install command      |
| ---------------------------------- | ---------------- | ---------------------- |
| `pnpm-lock.yaml`                    | pnpm              | `pnpm install`         |
| `yarn.lock`                         | yarn              | `yarn install`         |
| `package-lock.json`                 | npm               | `npm install`          |
| `bun.lock` / `bun.lockb`             | bun               | `bun install`          |
| `Cargo.lock`                        | cargo             | `cargo build`          |
| `go.sum`                            | go modules        | `go mod download`      |
| `poetry.lock`                       | poetry            | `poetry install`       |
| `uv.lock`                           | uv                | `uv sync`               |
| `Gemfile.lock`                      | bundler           | `bundle install`       |

If more than one lockfile is present (a migration in progress, or a
polyglot repo), ask which is authoritative rather than guessing.

### Check / verify / e2e commands

For a Node project, read `package.json#scripts` (root, and if it's a
workspace, look for a repo-wide aggregate script) for keys named (or
clearly equivalent to) `check`, `verify`, `test`, `lint`, `typecheck`,
`build`, `e2e`. For a non-Node project, check for a `Makefile`/`justfile`
with equivalent targets. Record whichever of these actually exist —
leave the rest `null` rather than inventing a script the repo doesn't have.
If the repo uses a monorepo tool (`turbo.json`, `nx.json`, `lerna.json`),
record its package-filter syntax as a `{package}` placeholder in `check`
(e.g. `"pnpm check --filter={package}"`) so `verification` rung 2 can
substitute it directly instead of rediscovering the syntax every time.

## 4. Companion rule packs

The marketplace that ships foreman also ships standalone rule packs. This
step installs the ones this repo actually needs, at **project scope**.

Nothing here re-detects the package manager: it reads the value step 3 just
resolved — including whichever lockfile the operator named as authoritative —
so the pack and `commands.packageManager` can never disagree.

### Prerequisite: register the marketplace *and* refresh its catalog

`omp plugin install` resolves `<plugin>@<marketplace>`, so the catalog has to
be known first. A foreman loaded via `omp plugin link` or `--extension` has no
marketplace entry at all.

Registering is not enough on its own: a marketplace install caches an
immutable copy of the catalog, so a marketplace added before these packs
existed still lists only `foreman`, and installing a pack fails with
`Plugin "<pack>" not found in marketplace "omp-foreman"` — which reads like a
wrong pack name rather than a stale cache. Always refresh:

```sh
omp plugin marketplace list                      # is omp-foreman registered?
omp plugin marketplace add andyhite/omp-foreman  # only if it isn't
omp plugin marketplace update omp-foreman        # always — the cache goes stale
```

If a pack still isn't found after a refresh, that is a real missing entry in
the catalog, not a caching problem. Stop and report it instead of guessing a
different name.

### One package-manager pack, keyed off `commands.packageManager`

| `commands.packageManager` | Pack |
| -------------------------- | ------ |
| pnpm | `pnpm` |
| npm | `npm` |
| yarn | `yarn` |
| bun | `bun` |
| uv | `uv` |
| cargo | `cargo` |
| pip — a `requirements.txt`/`requirements.in` with no `uv.lock` or `poetry.lock` | `pip` |

**Never install two.** Each asserts that its own tool is the package manager,
so a second one fires on every correct command of the first. `poetry`, `go
modules`, and `bundler` are detectable managers with **no pack yet** — say so
in the report rather than installing nothing silently, so it reads as a gap in
the marketplace instead of a detection failure.

### Always, for any git repo

`git-hygiene`, `shell-safety`, `secrets-hygiene`. Their subject matter —
irreversible git commands, `rm -rf`/`sudo`, credentials landing in the tree —
is present in every repo regardless of language or toolchain.

### Conditionally, only on evidence

| Pack | Install when |
| ------ | -------------- |
| `verification-integrity` | the repo has a test suite at all: a `test`/`e2e` script recorded in step 3, a test-runner config (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `pytest.ini`, `tox.ini`), or a `tests/`/`spec/` directory |
| `generated-files` | at least one of its globs matches a **tracked** file — check `git ls-files` for `*.generated.*`, `__generated__/`, `*.gen.*`, `*.pb.go`, `*_pb2.py`, `schema.graphql`, `prisma/migrations/`, `openapi.json`, `openapi.yaml` |

Check tracked files, not the working tree: a glob that only matches build
output under a gitignored directory is not evidence the repo hand-maintains
generated code. If nothing matches, skip `generated-files` and say why — a
pack that can never fire is permanent noise in every future session's rule
list.

### Install

Skip anything already present (`omp plugin list`), then:

```sh
omp plugin install --scope project <pack>@omp-foreman
```

Project scope is the whole point. The package-manager pack is a per-repo
choice, and a user-scoped `pnpm` pack would fire on every correct `npm
install` in the next repo you open.

A project-scope install writes omp's own state into `.omp/plugins/` —
`installed_plugins.json`, `omp-plugins.lock.json`, and a `node_modules/` tree
of symlinks into the plugin cache. That is machine-local and must not be
committed, while `.omp/foreman.json` beside it must be. Add the narrow path,
never the whole directory:

```sh
# .gitignore
.omp/plugins/
```

Getting this wrong in the blunt direction (`.omp/`) is worse than not doing
it: it silently un-commits the config every other foreman skill reads.

This is the only step that writes outside the repo's own files, so it is the
one to report in full: every pack installed, every pack skipped, and the
evidence behind each decision. If the operator already answered a "which
lockfile is authoritative" question in step 3, that answer picks the pack —
don't ask again.

## 5. Write the config

Write (or update) `.omp/foreman.json` at the repo root:

```json
{
  "repo": "<owner>/<repo>",
  "mainBranch": "<detected default branch>",
  "commitTypes": ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "style", "revert"],
  "labels": {
    "idea": "idea",
    "epic": "epic",
    "task": "task",
    "bug": "bug",
    "bugSeverities": ["sev0", "sev1", "sev2", "sev3"]
  },
  "board": {
    "owner": "<owner>",
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
    "packageManager": "<detected>",
    "install": "<detected>",
    "check": "<detected, or null>",
    "verify": "<detected, or null>",
    "e2e": "<detected, or null>"
  },
  "epicLoop": {
    "maxConcurrentTracks": 3
  },
  "plugins": {
    "marketplace": "omp-foreman",
    "packs": ["git-hygiene", "shell-safety", "secrets-hygiene", "<one package-manager pack>"]
  }
}
```

`board.statuses.<role>.name` is the **actual** option name on this repo's
board — it may not literally read "To Do"/"In Progress" if the board
predates this setup; every foreman skill that mentions a status by one of
those six names means the semantic role, resolved through this map.
`epicLoop.maxConcurrentTracks` defaults to 3; raise or lower it if the
project's review bandwidth or CI capacity says otherwise — it's a starting
point, not a measured value, so don't dress it up as detected.
`plugins.packs` records what step 4 concluded this repo needs — intent, not a
mirror of what omp currently has installed. Keeping it lets `skill://doctor`
notice the two disagreeing: a repo that migrated from pnpm to bun still has
the `pnpm` pack installed and firing on every correct `bun install`, which is
exactly the drift nothing else would catch.

Commit it — it's small, stable, and every other skill needs it; don't
gitignore it. If the repo already has one, diff before overwriting: a
hand-edited value (a corrected `commands.verify`, a narrower
`commitTypes`) is a deliberate project choice, not staleness — preserve it
and only fill in fields that are genuinely still empty.

## 6. Report

Confirm back: repo, project URL, which labels were created vs. already
present, the Status role → option-name → ID mapping, every detected
convention (main branch, commit types, package manager, check/verify/e2e
commands) with **which were detected vs. guessed vs. left null**, and the
path to the written config. If step 2 hit the "don't replace" branch, say
so explicitly — that board predates this run and needed careful merging,
not blind creation.

Then, separately, the rule packs: which were installed, which were skipped and
on what evidence, whether the marketplace had to be registered or its catalog
refreshed, and whether `.gitignore` needed the `.omp/plugins/` entry. If the
detected package manager has no pack yet, name it as a marketplace gap.

## Hazards

- **Never submit `updateProjectV2Field` without every existing option's
  current `id`.** The mutation replaces the whole option list; an option
  submitted without its `id` becomes a new option and every item's value
  for the dropped one is silently cleared. Recovery exists (each issue's
  timeline keeps `ProjectV2ItemStatusChangedEvent`) but avoid needing it.
- `gh project item-edit` needs the **item** ID (`PVTI_…`), not the issue ID —
  covered again in the `tracker` skill, worth repeating here since this is
  where people first hit it.
- A project can be owned by a user or an org; `--owner` must match exactly
  what `gh project list` reports, never a guess.
- A stray `GH_TOKEN` env var overrides `gh auth switch` and can
  authenticate every call above as the wrong account — prefix with `env -u
  GH_TOKEN` when in doubt.
- A detected `commands.*` value is a cache, not a promise: if a script gets
  renamed and a run of `verification` finds it missing, update the config
  rather than letting it silently point at a dead command.
- **A pack installed in step 4 is not active in the session that installed
  it.** omp resolves rules when a session starts; `omp plugin install` writes
  the install record without rebuilding the running session's capability set.
  Tell the operator to run `/reload-plugins`, and to restart the session if
  anything beyond skills and slash commands is involved — otherwise the rules
  you just reported as installed will not fire, which is worse than not having
  installed them, because now they're trusted.
- **`omp plugin install --dry-run` still installs.** The flag is advertised as
  "show actions without applying changes", but the install path ignores it and
  reports success having actually written the install. Don't use it to preview
  a pack list; decide the list first, then install for real, and use
  `omp plugin uninstall --scope project <pack>@omp-foreman` if you need to
  undo one.

This skill covers first-time setup and repair-on-request. For an ongoing
health check without re-running the full setup narrative, use
`skill://doctor` (`/foreman:doctor`) — it runs the same detection logic in
read-first, repair-what's-safe mode.
