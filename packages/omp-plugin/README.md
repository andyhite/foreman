# foreman

An omp plugin that runs a single-operator agile SDLC over Linear: triage the
inbox, refine prioritized issues, implement them in worktrees, and review the
diff, with every mutation applied by the extension from validated structured
output.

The plugin ships six agents, eight skills, ten commands (six Markdown,
four registered by the extension), three TTSR rules, and one extension
module (`src/extension.ts`) that owns the Linear write client, gate
validators, lock manager, and config loader.

This plugin is only ever active **per repo**, never user-wide, so it cannot
fire in a repo that does not use Foreman. Every registered repo symlinks the
single global copy at `~/.foreman/plugin`; nothing is copied, so every repo
moves together with the checkout that copy points at.

## Install

`foreman init`, run inside the target repo — see the repo root README. No
`omp plugin` subcommand is involved, because none of them can do this: omp
honors `--scope` for a marketplace install (`name@marketplace`) alone, so
`omp plugin link <dir>` and installs from a local path are unconditionally
user-wide regardless of the flag passed. `foreman init` writes omp's project
plugin root directly instead — a `node_modules` symlink to
`~/.foreman/plugin`, plus this machine's enable lock.

There is no build step. `omp.extensions` names `./src/extension.ts` and omp
loads the TypeScript directly, so there is no artifact to rebuild, to go
stale, or to ship missing.

`/reload-plugins` picks up changes to Markdown (agents, skills, commands,
rules) without a restart. It does **not** pick up changes to
`src/extension.ts` or anything it imports — those require restarting the omp
session.

## Configuration

Foreman reads one global config file:

- `~/.foreman/config.json` — the `repos` registry (alias → path, team, bound initiatives), loop tuning, and `repoDefaults`, deep-merged with each entry's overrides.

## Commands

| Command | Dispatches | Argument |
|---|---|---|
| `/foreman:triage` | `foreman-triage` over the Inbox | none |
| `/foreman:plan` | `foreman-plan` over one or more bare projects | `<PROJECT-ID>...` |
| `/foreman:roadmap` | `foreman-roadmap` over one initiative — creates sequenced projects | `<INITIATIVE-ID>` |
| `/foreman:refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman:implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` | `<ISSUE-ID or PR>` |
| `/foreman:apply` | extension code — reviews or applies staged proposals | none, `--yes`, `<ISSUE-ID> --approve`, or `<ISSUE-ID> --reject <reason>` |
| `/foreman:merge` | extension code — merges once the review gate passes | `<ISSUE-ID>` |
| `/foreman:unblock` | extension code — records the operator's reply and clears a block | `<ISSUE-ID>` |
| `/foreman:status` | extension code — renders the operator console | none |
