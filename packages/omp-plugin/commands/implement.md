---
description: Implement a refined, ready issue and open a PR
argument-hint: <ISSUE-ID>
---

Resolve issue `$1` via `foreman_linear_read`. Assemble the shared `context`
from the two-layer `Context` digest (§4.7) plus this issue's description,
acceptance criteria, and estimate.

Gate: the implementation gate must pass (refinement gate satisfied,
`agent:ready` present, `agent:running` absent, `agent:hands-off` absent, no
incomplete `blocked by` relations). Do not dispatch if it doesn't hold.

Before the spawn, the extension claims the `agent:running` lock for this
dispatch and creates or reuses the Foreman-managed worktree for the issue's
repo. The dispatch ID it wrote into the lock comment must be included in the
task `context`, so `foreman-implement` can verify the lock matches this
dispatch before doing anything.

Dispatch `foreman-implement` through the `task` tool with
`agent: foreman-implement` and the assembled `context`, including the
dispatch ID, as a single `tasks[]` entry — unlike plan/refine/review, which
may batch several subjects into one `task` call, an implement dispatch is
always one issue per invocation, never a batch: each issue needs its own
Foreman-managed worktree, and a non-isolated `task` spawn inherits its
parent session's cwd, so implement keeps its own per-issue agent rather than
sharing one orchestrator session. The extension revises the call to force
`schemaMode: "strict"`; do not set it yourself and do not try to override
it.

The agent returns an `ImplementResult`; the extension moves the issue to In
Review, releases the lock, and files any `discoveredWork` as new Backlog
issues.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the implementation procedure here — it lives in the
`foreman-implement-issue` skill, autoloaded by the `foreman-implement` agent.
