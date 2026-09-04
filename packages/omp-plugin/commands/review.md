---
description: Review the diffs for one or more in-review issues against their acceptance criteria and the Definition of Done
argument-hint: <ISSUE-ID or PR>...
---

<critical>
- ONE `task` call; every passing target its own `tasks[]` entry. NEVER one call per target, NEVER a partial batch: `foreman-*` agents are `blocking: true`, so one call runs N items concurrently and returns all N results on the one channel the extension captures.
- Each task text MUST carry `FOREMAN-ISSUE: <ISSUE-ID>` on its own line.
- Cold review: NEVER put implementation rationale, conversation history, or your own reading of the diff in `context` or task text. The agent gets the diff path, the issue, the SHA, and the `Context` digest; nothing else.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the review procedure; `foreman-review-diff` is autoloaded.
</critical>

## Resolve

Each target in `$ARGUMENTS` (issue id or PR) → its issue via
`foreman_linear_read` `op: "issue"` with `id:` the target; its PR via
`foreman_github_pr` `view` with `head` = the issue's branch. Head SHA: the
PR head, or `git rev-parse <branch>` when `pr.required: false`.

## Gate (per target)

PR open for the issue (or branch pushed when `pr.required: false`), and no
`ReviewResult` yet for the current head SHA. Fails → skip it; dispatch the
rest. A failing item inside the call blocks the whole call, so filter before
dispatching.

## Dispatch

`agent: foreman-review` per entry. Task text: `FOREMAN-ISSUE: <ISSUE-ID>`,
the head SHA, the issue's acceptance criteria and Out of Scope, and that
issue's two-layer `Context` digest (product `Context` doc + project brief,
Definition of Done included). The extension fetches the diff before the
spawn and appends a `FOREMAN-DIFF: <path>` line; the agent reads the file
itself. NEVER inline diff text.

## After

`ReviewResult` → extension renders a Linear comment and a PR review, and
drives the review gate and fix cycle from it.
