---
description: Review the diff for an in-review issue against its acceptance criteria and the Definition of Done
argument-hint: <ISSUE-ID or PR>
---

Resolve the target issue or PR `$1` via `foreman_linear_read`. Gate: a PR is
open for the issue (or, with `pr.required: false`, the branch is pushed), and
no `ReviewResult` exists yet for the current head SHA.

The agent holds no git or GitHub tool. Before the spawn, the extension fetches
the diff and head SHA — from the PR via its GitHub read client, or from git
when `pr.required: false` — and writes them to a file. Put that file's path,
not the diff text, in the task `context`, alongside the project `Context` doc
digest and the issue's acceptance criteria. The agent `read`s the file itself.

Cold-context warning: review runs in a fresh child session with no memory of
the implementation conversation. Do not put implementation rationale in
`context` — that defeats the cold review this dispatch exists to guarantee.
Give it only the diff file path, the issue, and the `Context` doc.

Dispatch `foreman-review` through the `task` tool with `agent: foreman-review`
and the assembled `context`. The extension revises the call to force
`schemaMode: "strict"`; do not set it yourself and do not try to override it.

The agent returns a `ReviewResult`; the extension renders it as a Linear
comment and a PR review, and drives the review gate and fix cycle from it.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the review procedure here — it lives in the
`foreman-review-diff` skill, autoloaded by the `foreman-review` agent.
