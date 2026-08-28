---
description: Refine a prioritized issue into an implementable description with acceptance criteria
argument-hint: <ISSUE-ID>
---

Resolve issue `$1` via `foreman_linear_read`. Assemble the shared `context`
from the two-layer `Context` digest (§4.7) plus this issue's current state
(description, priority, estimate, labels, relations).

Gate: Priority ≠ `None`. If the issue is unprioritized, do not dispatch — tell
the operator to set a priority first.

Dispatch `foreman-refine` through the `task` tool with `agent: foreman-refine`
and the assembled `context`. `foreman-refine` is `blocking: true`, so this
runs inline in the current session rather than in the background. The
extension revises the call to force `schemaMode: "strict"`; do not set it
yourself and do not try to override it.

The agent returns a `RefineResult`; the extension applies the description,
any sub-issues or spike, `agent:ready`, the move to Todo, and strips
`legacy`. Nothing else changes state.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the refinement procedure here — it lives in the
`foreman-refine-issue` skill, autoloaded by the `foreman-refine` agent.
