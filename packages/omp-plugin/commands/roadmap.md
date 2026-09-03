---
description: Decompose one or more initiatives' briefs into their next slate of projects
argument-hint: <INITIATIVE-ID>...
---

Resolve each initiative id in `$ARGUMENTS` via `foreman_linear_read`. Assemble
each one's shared `context` from the two-layer product `Context` digest
(`project_context`, initiative layer only — there is no project yet) plus
that initiative's existing roadmap, read via the `initiative_roadmap` op:
every project already attached, its status, dates, and dependency edges.
`foreman-roadmap` places new work relative to that existing roadmap, not in
a vacuum.

Every initiative id in `$ARGUMENTS` gets its own `tasks[]` entry, each with
`agent: foreman-roadmap`, its own assembled `context`, and its own
`FOREMAN-INITIATIVE: <INITIATIVE-ID>` marker in the task text — dispatch all
of them in a SINGLE `task` call, never one `task` call per initiative id and
never a partial batch. Every `foreman-*` agent is `blocking: true`, so one
call with N items runs them concurrently and returns all N structured
results on the one channel the extension can capture; splitting the call
loses that. The extension revises the call to force `schemaMode: "strict"`
on every item; do not set it yourself and do not try to override it.

The agent returns a `RoadmapResult`; the extension creates each
`proposedProjects[]` entry as a new project attached to the initiative, sets
its dates, and wires every `blockedBy` / `blockedByExisting` edge into a
native `dependency` relation. Nothing below the project level changes —
`foreman-plan` is what turns a created, approved project into its first
slate of issues, exactly as it already does for a project created any other
way.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the roadmapping procedure here — it lives in the
`foreman-plan-roadmap` skill, autoloaded by the `foreman-roadmap` agent.
