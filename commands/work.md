---
description: Deliver one task or bug issue through the orchestration loop, pinned to that issue
argument-hint: "<issue-number>"
---

Deliver issue #$1.

This is the orchestration loop with a queue of one. Read
`skill://epic-loop` and run it exactly as written — the same claim,
worktree provisioning, worker dispatch (per `policy.epicLoop.dispatch`),
monitoring, verification,
and retirement machinery as any other track; the only difference is
selection: the queue is pinned to #$1, and the loop ends when that issue
lands. You conduct; the worker runs the dev loop — you never edit product
code, open the PR, or merge anything yourself, and every worktree the
track needs is created and retired by you through that loop, never by the
worker.

Three checks before anything moves: if #$1 is labeled `epic`, stop and
tell me to use `/foreman:orchestrate $1` instead; if it is not at `To Do`
(or carries an untriaged bug label), stop and tell me what state it is
actually in; if it carries `<labels.readyForHuman>` (`.omp/foreman.json`,
conventionally `ready-for-human`), stop and tell me instead of claiming
it — `To Do` means an agent may claim the issue, and that label is the
only way to park a `To Do` item a human must do by hand. Skip this guard
when the repo has not set `labels.readyForHuman`. Do not work around the
lifecycle.

The worker's planner dispatch, TDD enforcement, QA gate, and merge policy
come from `policy.*` in `.omp/foreman.json`; a bug-labeled issue enters
`skill://diagnosing-bugs` before planning. Under the default
`policy.delivery.mergePolicy` of `operator`, **I merge** — the merge is
the approval, and my comments on the PR are change requests the worker
picks up.

**Keep the todo list synced to reality as you go**: mark each step `done`
in the same turn you verify it — never a report that "shipped" while todos
sit open. Report at the end: PR, what shipped, how it was proven, board
state, worktree retired, and confirm every todo is `done` or explicitly
dropped.
