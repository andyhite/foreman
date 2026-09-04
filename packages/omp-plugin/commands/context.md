---
description: Propose edits to the repo's team's product Context doc from its own docs, code, and existing projects
argument-hint: ""
---

<critical>
- ONE `task` call, ONE `tasks[]` entry: a context run is scoped to this repo's one team, never a batch.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the context-doc procedure; `foreman-context-doc` is autoloaded.
</critical>

## Resolve

The live product `Context` doc for this repo's team via `foreman_linear_read`
op `context` — all four sections, Definition of Done included.

## Gate

None. Operator-invoked only.

## Dispatch

`agent: foreman-context`, one entry. Task text: the `context` op's digest.
`foreman-context` reads the repo's own docs, code, and existing projects
itself; nothing else to assemble here.

## After

`ContextResult` → extension merges `decisions`, `vocabulary`, and `nonGoals`
plus `removals` into the live doc via `mergeContextDoc`, carrying the
Definition of Done through verbatim, and refuses the whole result — writing
nothing — if any line dropped from a section is not declared in `removals`.
