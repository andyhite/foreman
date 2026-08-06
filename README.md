# omp-foreman

An [omp](https://github.com/oh-my-pi) extension that packages a
GitHub-issue-tracker-driven development workflow — ideas → epics/tasks →
worktrees → TDD implementation → QA gate → (stacked) pull requests →
operator merge — as reusable commands, skills, and agents, all under the
`/foreman:*` slash-command namespace. It carries no hardcoded repo, org, or
tech stack: every project-specific constant (repo, GitHub Projects v2
board, label vocabulary, commit-type set, package manager, check/verify/
e2e commands) is resolved once by `/foreman:init` and read back out of
`.omp/foreman.json`.

The package is named `omp-foreman` (repo: `andyhite/omp-foreman`) because
plain `foreman` already names an unrelated process manager; the shorter
`foreman` name lives on as the in-session vocabulary — the slash-command
prefix, the skill/agent names, and the `.omp/foreman.json` config file.

This is the generalized, project-agnostic form of a workflow originally
built inside one specific repo; if you're looking at both side by side,
this one is the reusable half.

## What it gives you

- **Commands** (`commands/foreman:*.md`): `/foreman:init`, `/foreman:help`,
  `/foreman:record`, `/foreman:groom`, `/foreman:work <issue>`,
  `/foreman:orchestrate <epic>`, `/foreman:report`, `/foreman:triage`.
- **Skills** (`skills/*/SKILL.md`): `bootstrap` (backs `/foreman:init`),
  `tracker`, `worktree`, `dev-loop`, `epic-loop`, `grooming`, `bug-triage`,
  `verification`, `stacked-prs`.
- **Agents** (`agents/*.md`): `planner`, `qa`, `issue-worker`.
- **Rules** (`rules/*.md`): tool-call interrupts for the sharp edges — force
  pushes, destructive git, pushing at the main branch, closing issues by
  hand, softening tests, skipping hooks.

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

- **As an installable plugin** — `omp plugin link /path/to/omp-foreman`
  (local dev), or publish it to a marketplace catalog and `omp plugin
  install omp-foreman@<marketplace>`.

Restart the session (or `/reload-plugins`) after adding it.

## Quick start

```
/foreman:init         # one-time (or repair) setup: labels + project board + .omp/foreman.json
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
