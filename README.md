# Foreman

An [omp](https://github.com/oh-my-pi) extension that packages a
GitHub-issue-tracker-driven development workflow — ideas → epics/tasks →
worktrees → TDD implementation → QA gate → (stacked) pull requests →
operator merge — as reusable commands, skills, and agents. It carries no
hardcoded repo, org, or tech stack: every project-specific constant (repo,
GitHub Projects v2 board, label vocabulary) is resolved once by
`/foreman:init` and read back out of `.omp/foreman.json`.

This is the generalized, project-agnostic form of a workflow originally
built inside one specific repo; if you're looking at both side by side, this
one is the reusable half.

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
    - /path/to/foreman
  ```

- **Every project** — add to your user agent config
  (`~/.omp/agent/config.yml`):

  ```yaml
  extensions:
    - /path/to/foreman
  ```

- **As an installable plugin** — `omp plugin link /path/to/foreman` (local
  dev), or publish it to a marketplace catalog and `omp plugin install
  foreman@<marketplace>`.

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
  `package.json` scripts / `Makefile` / monorepo tool / CI config instead of
  assuming pnpm, vitest, or turbo.
- **No hardcoded repo.** Every skill reads `.omp/foreman.json` (written by
  `/foreman:init`) for the repo, project board IDs, and label vocabulary.
- **The operator always merges.** Every skill and agent treats "the
  operator merges the PR" as the approval and "the operator commented on
  the PR" as a change request — no agent merges on its own judgment.
