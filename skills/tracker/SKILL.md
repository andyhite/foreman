---
name: tracker
description: The single source of truth for foreman work tracking on a GitHub repo — issue lifecycle, label vocabulary, board statuses, epic status derivation, and the exact gh/GraphQL recipes for every transition. Read before creating, relabeling, or moving any issue. Constants come from .omp/foreman.json — run /omp-foreman:init first if it's missing.
---

# Tracker — GitHub Issues + the project board

Everything that is work is a GitHub issue in this repo, tracked on a GitHub
Projects v2 board. The board is the only shared memory between concurrent
sessions: **move state the moment it changes**, and trust the board over
your assumptions — an item nobody moved reads as work available.

## Constants

Read `.omp/foreman.json` at the repo root for every value below. If it's
missing, run `/omp-foreman:init` (`skill://bootstrap`) before doing anything
else — nothing in this skill works without it.

| Thing                | Source in `.omp/foreman.json`         |
| --------------------- | ---------------------------------------- |
| Repository             | `repo`                                   |
| Main branch            | `mainBranch`                             |
| Project owner/number   | `board.owner` / `board.projectNumber`    |
| Project node ID        | `board.projectNodeId`                    |
| Status field ID        | `board.statusFieldId`                    |
| Status role → name/ID  | `board.statuses.<role>.{name,id}`        |
| Label vocabulary       | `labels.*`                               |

If an ID ever fails to resolve, re-derive it (`gh project field-list
<number> --owner <owner> --format json`) and correct the config — never
guess.

### Status roles

This skill (and every other foreman skill) talks about statuses by six
**semantic roles** — `backlog`, `todo`, `inProgress`, `review`, `done`,
`rejected` — not by literal text. `board.statuses.<role>.name` is
whatever this repo's board actually calls that column (most repos use the
obvious names below; a repo whose board predates foreman may not). Every
time this skill or another says a status like "`To Do`", read it as the
`todo` role and substitute `board.statuses.todo.name` if this repo's board
calls it something else.

## Labels

| Label                            | Meaning                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `labels.idea` (default `idea`)     | Recorded intention, minimal detail. Awaits grooming.                      |
| `labels.epic` (default `epic`)     | Large multi-task effort. Never actionable itself; broken into sub-issues. |
| `labels.task` (default `task`)     | Small, directly actionable unit: one PR, one worktree.                    |
| `labels.bug` (default `bug`)       | Untriaged bug report — triage replaces it with a severity label.          |
| `<bug>:sev0` … `<bug>:sevN`         | Triaged bug; severity rubric in the `bug-triage` skill. The exact set is `labels.bugSeverities`. |

Exactly one type label per issue. Ideas become epics or tasks at grooming;
bugs keep a `bug*` label for life and are **never** relabeled `task` or
`epic`.

List all bugs regardless of triage state (search commas are OR):

```sh
gh issue list --search "label:bug,bug:sev0,bug:sev1,bug:sev2,bug:sev3" --state open
```

(Substitute this repo's actual `labels.bug` prefix and `labels.bugSeverities`
list if they differ from the defaults.)

## Statuses and who moves them

| Role (config key) | Default name  | Meaning                                            | Entered when                                                                                          |
| ------------------ | ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backlog`           | `Backlog`     | Captured, not committed to                          | Idea recorded; epic accepted; low-severity bug filed                                                  |
| `todo`              | `To Do`       | Committed, next up, ordered by priority             | Task accepted at grooming; epic breakdown lands; high-severity bug filed; low-severity bug promoted    |
| `inProgress`        | `In Progress` | Actively being worked in a worktree                 | A session claims it — **before its first edit**                                                        |
| `review`            | `Review`      | PR open, checks green, waiting on the operator      | The PR opens. An operator comment on the PR is a change request → falls back to `inProgress`          |
| `done`              | `Done`        | Operator-merged to the main branch, worktree gone   | The operator merges the PR — the merge **is** the approval. `done` only after merge **and** cleanup    |
| `rejected`          | `Rejected`    | Groomed and declined                                | Grooming rejects an idea; issue is closed as not planned                                              |

Lifecycle: `idea → backlog` → grooming → (`rejected` | `task → todo` |
`epic → backlog` → breakdown → subtasks `todo`) → `inProgress` → `review` →
`done`. Bugs skip the idea stage: triage routes the top severities straight
to `todo` and the rest to `backlog` (`bug-triage` skill).

Chained epic subtasks ship as **stacked PRs** — one layer per subtask, each
layer's issue moving through `review`/`done` exactly as above as its layer
PR opens and merges; see `skill://stacked-prs`.

## Epic status is derived from its subtasks

An epic never moves on its own. Recompute after every subtask transition:

1. All subtasks `done` **and** epic integration verification passed →
   `done` (close the epic).
2. Else, all subtasks at `review` or `done` → `review`.
3. Else, any subtask at `inProgress`, `review`, or `done` → `inProgress`.
4. Else, any subtask at `todo` → `todo`.
5. Else → `backlog`.

This is bidirectional: a subtask falling back (e.g. `review → inProgress`
on requested changes) pulls the epic back with it.

## Recipes

Substitute this repo's values from `.omp/foreman.json` wherever a recipe
below names `<owner>`, `<repo>`, `<number>`, a field/option ID, or a label.
`<OPTION_ID>` below means `board.statuses.<role>.id` for whichever role
applies.

### Create an issue

```sh
gh issue create --title "<title>" --label <labels.idea> --body "<body>"
```

Titles are plain descriptive sentences, matching this repo's existing
issue-title style — check a few recent ones before inventing a new tone.

### Add it to the board and set status

```sh
ITEM=$(gh project item-add <number> --owner <owner> --url <issue-url> --format json --jq '.id')
gh project item-edit --id "$ITEM" --project-id <board.projectNodeId> \
  --field-id <board.statusFieldId> --single-select-option-id <board.statuses.<role>.id>
```

### Find the board item for an existing issue

```sh
ITEM=$(gh api graphql -f query='query{repository(owner:"<owner>",name:"<repo>"){
  issue(number:<N>){projectItems(first:10){nodes{id project{number}}}}}}' \
  --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number==<number>) | .id')
```

### Read an issue's current status

```sh
gh api graphql -f query='query{repository(owner:"<owner>",name:"<repo>"){
  issue(number:<N>){projectItems(first:10){nodes{project{number}
    fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}'
```

Match the returned `name` against `board.statuses.*.name` to get the role.

### Link a task to its epic (sub-issue)

```sh
PARENT=$(gh issue view <epic-number> --json id --jq .id)
CHILD=$(gh issue view <task-number> --json id --jq .id)
gh api graphql -f query="mutation{addSubIssue(input:{issueId:\"$PARENT\",subIssueId:\"$CHILD\"}){issue{number}}}"
```

List an epic's subtasks with statuses in one query:

```sh
gh api graphql -f query='query{repository(owner:"<owner>",name:"<repo>"){
  issue(number:<EPIC>){subIssues(first:50){nodes{number title state labels(first:5){nodes{name}}
    projectItems(first:5){nodes{project{number}
      fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}'
```

### Reject an idea

```sh
gh issue close <N> --reason "not planned" --comment "<why, in one or two sentences>"
# then set the board item's status to the `rejected` role (board.statuses.rejected.id)
```

### Relabel at grooming

```sh
gh issue edit <N> --remove-label <labels.idea> --add-label <labels.task>   # or labels.epic
gh issue edit <N> --body-file <respecced-body.md>
```

### Record a blocker

Blockers live on the issue, not in your head:

```sh
gh issue comment <N> --body "Blocked: <what, since when, what would unblock it>"
```

## Hazards

- **Never edit the Status field's options without carrying over each
  existing option's `id`.** `updateProjectV2Field` _replaces_ the option
  list; an option submitted without its current `id` becomes a new option
  and every item's value for the old one is silently cleared. (Recovery
  exists — each issue's timeline keeps `ProjectV2ItemStatusChangedEvent` —
  but do not get there.)
- `gh project item-edit` needs the **item** ID (`PVTI_…`), not the issue ID.
- A PR body containing `Closes #N` closes the issue on merge, but does
  **not** move the board status — set the `done` role explicitly after
  merge and cleanup.
- Exactly one type label per issue: adding `task` means removing `idea`;
  adding a severity label means removing the plain `bug` label.
- If a `gh` call authenticates as the wrong account, `env -u GH_TOKEN`
  before it — a stray `GH_TOKEN` env var overrides `gh auth switch`.
