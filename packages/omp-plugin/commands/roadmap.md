---
description: Decompose one or more initiatives' briefs into their next slate of projects
argument-hint: <INITIATIVE-ID>...
---

<critical>
- ONE `task` call; every initiative its own `tasks[]` entry. NEVER one call per initiative, NEVER a partial batch: `foreman-*` agents are `blocking: true`, so one call runs N items concurrently and returns all N results on the one channel the extension captures.
- Each task text MUST carry `FOREMAN-INITIATIVE: <INITIATIVE-ID>` on its own line; the extension keys result capture on it.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the roadmapping procedure; `foreman-plan-roadmap` is autoloaded.
</critical>

## Resolve

Each initiative id in `$ARGUMENTS` via `foreman_linear_read`:
`project_context` at the initiative layer (product `Context` doc; no project
exists yet) and `initiative_roadmap` (every attached project: status, dates,
dependency edges). The extension appends nothing for roadmap; you assemble
both.

## Gate

None. Operator-invoked only.

## Dispatch

`agent: foreman-roadmap` per entry. Task text:
`FOREMAN-INITIATIVE: <INITIATIVE-ID>`, the initiative's brief, its product
`Context` doc, and its existing roadmap. `foreman-roadmap` places new work
relative to that roadmap, never in a vacuum.

## After

`RoadmapResult` → extension creates each `proposedProjects[]` entry attached
to the initiative, sets dates, wires every `blockedBy` /
`blockedByExisting` edge into a native `dependency` relation. Nothing below
the project level changes; `foreman-plan` seeds a created, approved project
the normal way.
