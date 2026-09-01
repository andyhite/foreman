# foreman

An omp plugin that runs a single-operator agile SDLC over Linear: triage the
inbox, refine prioritized issues, implement them in worktrees, and review the
diff, with every mutation applied by the extension from validated structured
output.

The plugin ships four agents, six skills, eight commands, three TTSR rules,
and one extension module (`src/extension.ts`) that owns the Linear write
client, gate validators, lock manager, and config loader.

This plugin is always installed **project-scoped** — into one specific repo,
never user-wide. Installing it here does not touch, shadow, or conflict with
any install in another repo; each repo gets its own copy, installed by that
repo's `foreman init`.

## Install

There is no dev-mode plugin linking: omp only honors `--scope` for a
marketplace install (`name@marketplace`) — `omp plugin link <dir>` and
installs from a local path are unconditionally user-wide regardless of any
flag passed. So there is no local-development install path that stays
project-scoped either; the plugin is always installed the same way
production repos get it, project-scoped via `foreman init` (see the repo
root README), which resolves to:

```
omp plugin marketplace add andyhite/foreman
omp plugin install foreman@foreman --scope project
```

run inside the target repo, after `bun install && bun run build` — the
extension bundle at `dist/extension.js` is build output and is not committed.

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
| `/foreman:refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman:implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` | `<ISSUE-ID or PR>` |
| `/foreman:apply` | extension code — reviews or applies staged proposals | none, `--yes`, `<ISSUE-ID> --approve`, or `<ISSUE-ID> --reject <reason>` |
| `/foreman:merge` | extension code — merges once the review gate passes | `<ISSUE-ID>` |
| `/foreman:unblock` | extension code — records the operator's reply and clears a block | `<ISSUE-ID>` |
| `/foreman:status` | extension code — renders the operator console | none |
