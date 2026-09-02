---
description: Review the diffs for one or more in-review issues against their acceptance criteria and the Definition of Done
argument-hint: <ISSUE-ID or PR>...
---

Resolve each target issue or PR in `$ARGUMENTS` via `foreman_linear_read`.
Gate per target: a PR is open for the issue (or, with `pr.required: false`,
the branch is pushed), and no `ReviewResult` exists yet for the current head
SHA. Skip a target that fails its gate and dispatch the rest of the batch
normally.

The agent holds no git or GitHub tool. Before the spawn, the extension
fetches each target's diff and head SHA — from the PR via its GitHub read
client, or from git when `pr.required: false` — and writes them to a file.
Put that file's path, not the diff text, in that item's task `context`,
alongside the two-layer `Context` digest (§4.7) and the issue's acceptance
criteria. The agent `read`s the file itself.

Cold-context warning: review runs in a fresh child session with no memory of
the implementation conversation. Do not put implementation rationale in
`context` — that defeats the cold review this dispatch exists to guarantee.
Give it only the diff file path, the issue, and the two-layer `Context`
digest.

Every target that passes its gate gets its own `tasks[]` entry, each with
`agent: foreman-review`, its own assembled `context`, and its own
`FOREMAN-ISSUE: <ISSUE-ID>` marker in the task text — dispatch all of them
in a SINGLE `task` call, never one `task` call per target and never a
partial batch. Every `foreman-*` agent is `blocking: true`, so one call with
N items runs them concurrently and returns all N structured results on the
one channel the extension can capture; splitting the call loses that. The
extension revises the call to force `schemaMode: "strict"` on every item; do
not set it yourself and do not try to override it.

The agent returns a `ReviewResult`; the extension renders it as a Linear
comment and a PR review, and drives the review gate and fix cycle from it.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the review procedure here — it lives in the
`foreman-review-diff` skill, autoloaded by the `foreman-review` agent.
