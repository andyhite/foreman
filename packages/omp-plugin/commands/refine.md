---
description: Refine one or more prioritized issues into implementable descriptions with acceptance criteria
argument-hint: <ISSUE-ID>...
---

<critical>
- ONE `task` call; every passing issue its own `tasks[]` entry. NEVER one call per issue, NEVER a partial batch: `foreman-*` agents are `blocking: true`, so one call runs N items concurrently and returns all N results on the one channel the extension captures.
- Each task text MUST carry `FOREMAN-ISSUE: <ISSUE-ID>` on its own line.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the refinement procedure; `foreman-refine-issue` is autoloaded.
</critical>

## Resolve

Each issue id in `$ARGUMENTS` via `foreman_linear_read`: description,
priority, estimate, labels, relations.

## Gate (per issue)

Priority ≠ `None`. Unprioritized → skip it, tell the operator to set a
priority; dispatch the rest. A failing item inside the call blocks the whole
call, so filter before dispatching.

## Dispatch

`agent: foreman-refine` per entry. Task text: `FOREMAN-ISSUE: <ISSUE-ID>`,
the issue's current state, and that issue's two-layer `Context` digest
(product `Context` doc + project brief, Definition of Done included). Shared
`context`: only what every entry has in common.

## After

`RefineResult` → extension writes the description, sub-issues or spike, and
moves the issue to Todo when ready for implementation. Nothing else changes
state.
