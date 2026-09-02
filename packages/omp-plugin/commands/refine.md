---
description: Refine one or more prioritized issues into implementable descriptions with acceptance criteria
argument-hint: <ISSUE-ID>...
---

Resolve each issue id in `$ARGUMENTS` via `foreman_linear_read`. Assemble
each one's shared `context` from the two-layer `Context` digest (§4.7) plus
that issue's current state (description, priority, estimate, labels,
relations).

Gate per issue: Priority ≠ `None`. If an issue is unprioritized, do not
dispatch it — tell the operator to set a priority first; dispatch the rest
of the batch normally.

Every issue id in `$ARGUMENTS` that passes the gate gets its own `tasks[]`
entry, each with `agent: foreman-refine`, its own assembled `context`, and
its own `FOREMAN-ISSUE: <ISSUE-ID>` marker in the task text — dispatch all
of them in a SINGLE `task` call, never one `task` call per issue id and
never a partial batch. Every `foreman-*` agent is `blocking: true`, so one
call with N items runs them concurrently and returns all N structured
results on the one channel the extension can capture; splitting the call
loses that. The extension revises the call to force `schemaMode: "strict"`
on every item; do not set it yourself and do not try to override it.

The agent returns a `RefineResult`; the extension applies the description,
any sub-issues or spike, `agent:ready`, the move to Todo, and strips
`legacy`. Nothing else changes state.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the refinement procedure here — it lives in the
`foreman-refine-issue` skill, autoloaded by the `foreman-refine` agent.
