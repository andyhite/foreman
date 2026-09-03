---
description: Decompose the repo's team into its next slate of projects, optionally from a brief/PRD/spec document
argument-hint: "[DOCUMENT-PATH]"
---

<critical>
- ONE `task` call, ONE `tasks[]` entry: a roadmap run is scoped to this repo's one team, never a batch.
- Emit `FOREMAN-BRIEF: $1` on its own line only when `$1` is non-empty; omit the line entirely otherwise.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the roadmapping procedure; `foreman-plan-roadmap` is autoloaded.
</critical>

## Resolve

The repo's existing projects (name, status, dates, dependency edges) via
`foreman_linear_read` op `team_roadmap`. Then the brief: read `$1` with the
`read` tool when supplied; otherwise read `README.md` and `AGENTS.md` at the
repo root.

## Gate

None. Operator-invoked only.

## Dispatch

`agent: foreman-roadmap`, one entry. Task text: `FOREMAN-BRIEF: $1` (only
when `$1` is non-empty), the brief content you read, and the team's existing
roadmap. `foreman-roadmap` places new work relative to that roadmap, never
in a vacuum.

## After

`RoadmapResult` → extension creates each `proposedProjects[]` entry under
`teamId`, sets dates, wires every `blockedBy` / `blockedByExisting` edge
into a native `dependency` relation. Nothing below the project level
changes; `foreman-plan` seeds a created, approved project the normal way.
