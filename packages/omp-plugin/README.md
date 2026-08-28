# foreman

An omp plugin that runs a single-operator agile SDLC over Linear: triage the
inbox, refine prioritized issues, implement them in worktrees, and review the
diff, with every mutation applied by the extension from validated structured
output.

The plugin ships four agents, six skills, eight commands, three TTSR rules,
and one extension module (`src/extension.ts`) that owns the Linear write
client, gate validators, lock manager, and config loader.

> **A plugin named `foreman` is already installed on this machine, at version
> 0.14.2, from this same GitHub repo.** Installing the local development copy
> below replaces it. Uninstall or note the version if you need to roll back.

## Install (local development)

From the repo root:

```
/marketplace add ./
/marketplace install --scope user foreman@foreman-dev
```

This reads `.omp-plugin/marketplace.json` at the repo root and installs the
plugin at `packages/omp-plugin/` user-scoped, so it applies across every
personal repo.

`/reload-plugins` picks up changes to Markdown (agents, skills, commands,
rules) without a restart. It does **not** pick up changes to
`src/extension.ts` or anything it imports — those require restarting the omp
session.

## Configuration

Foreman reads layered JSON config, repo overrides winning over global:

- `~/.foreman/config.json` — project→repo map, loop tuning, repo defaults.
- `<repo>/.foreman/config.json` — per-repo overrides, versioned with the code.

## Commands

| Command | Dispatches | Argument |
|---|---|---|
| `/foreman:triage` | `foreman-triage` over the Inbox | none |
| `/foreman:refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman:implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` | `<ISSUE-ID or PR>` |
| `/foreman:apply` | extension code — applies approved triage proposals | none |
| `/foreman:merge` | extension code — merges once the review gate passes | `<ISSUE-ID>` |
| `/foreman:unblock` | extension code — records the operator's reply and clears a block | `<ISSUE-ID>` |
| `/foreman:status` | extension code — renders the operator console | none |
