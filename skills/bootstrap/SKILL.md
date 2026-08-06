---
name: bootstrap
description: Setting up GitHub issue tracking for a repo under the foreman workflow — repo check, label vocabulary, a GitHub Projects v2 board with a Status field, and writing the resolved constants to .omp/foreman.json. Read when running /foreman:init or repairing a project's tracker config.
---

# Bootstrap — wire a repo into the foreman workflow

Every other foreman skill (`tracker`, `dev-loop`, `epic-loop`, `grooming`,
`bug-triage`, `verification`, `stacked-prs`) reads its constants from
`.omp/foreman.json` at the repo root. This skill is how that file gets
created, or repaired — it is what `/foreman:init` runs.

Idempotent throughout: re-running it against an already-wired repo should
find everything and change nothing, not create duplicates.

## 0. Preconditions

- `gh auth status` succeeds — fail loudly and stop otherwise; everything
  below needs it. If more than one `gh` account is authenticated and the
  wrong one is active, say so before proceeding rather than guessing.
- The current directory is a git repo with a GitHub remote:
  `gh repo view --json nameWithOwner,defaultBranchRef`. If there's no remote
  yet, ask whether to create one (`gh repo create <name> --source=. --push`)
  or point at an existing one — never guess a repo name or silently create
  one without asking.

## 1. Labels

Check what already exists first (`gh label list --json name,color`), then
create only what's missing:

| Label                                          | Color (suggestion)                   | Meaning                                         |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
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

If the project wants a different label vocabulary (different names, extra
severities), don't fight these defaults into shape — create what the
project actually wants and record the mapping in `.omp/foreman.json#labels`.
Every other skill reads the config, never a hardcoded list.

## 2. GitHub Projects v2 board

Check for an existing project first — don't create a second board for a repo
that already has one:

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

Look for a single-select field named `Status`. If it doesn't exist, create it
with exactly these options (their order sets the board's default column
order, not their IDs):

```sh
gh project field-create <number> --owner <owner> --name Status \
  --data-type SINGLE_SELECT \
  --single-select-options "Backlog,To Do,In Progress,Review,Done,Rejected"
```

If a `Status` field already exists with a **different** option set, do not
replace it outright — see the hazard below. Map the workflow onto whatever
options exist, or add the missing ones via the GraphQL
`updateProjectV2Field` mutation while carrying over every existing option's
`id` unchanged (only appending new ones).

Record every option's ID: `gh project field-list <number> --owner <owner>
--format json` returns each field's `options[].{name,id}`.

## 3. Write the config

Write (or update) `.omp/foreman.json` at the repo root:

```json
{
  "repo": "<owner>/<repo>",
  "mainBranch": "<default branch>",
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
    "statusOptions": {
      "Backlog": "...",
      "To Do": "...",
      "In Progress": "...",
      "Review": "...",
      "Done": "...",
      "Rejected": "..."
    }
  }
}
```

Commit it — it's small, stable, and every other skill needs it; don't
gitignore it. If the repo already has one, diff before overwriting: a
hand-edited `labels` mapping is a deliberate project choice, not staleness.

## 4. Report

Confirm back: repo, project URL, which labels were created vs. already
present, the Status option IDs, and the path to the written config. If step
2 hit the "don't replace" branch, say so explicitly — that board predates
this run and needed careful merging, not blind creation.

## Hazards

- **Never submit `updateProjectV2Field` without every existing option's
  current `id`.** The mutation replaces the whole option list; an option
  submitted without its `id` becomes a new option and every item's value for
  the dropped one is silently cleared. Recovery exists (each issue's
  timeline keeps `ProjectV2ItemStatusChangedEvent`) but avoid needing it.
- `gh project item-edit` needs the **item** ID (`PVTI_…`), not the issue ID —
  covered again in the `tracker` skill, worth repeating here since this is
  where people first hit it.
- A project can be owned by a user or an org; `--owner` must match exactly
  what `gh project list` reports, never a guess.
- A stray `GH_TOKEN` env var overrides `gh auth switch` and can authenticate
  every call above as the wrong account — prefix with `env -u GH_TOKEN` when
  in doubt.
