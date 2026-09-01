---
description: Triage the Linear Inbox and propose classification, priority, and destination for each item
argument-hint: [--stale-low-days <days>] <ISSUE-ID...>
---

Triage exactly the issues named in `$ARGUMENTS` (space-separated identifiers,
e.g. `ENG-101 ENG-102`), not the whole Inbox view — the dispatch already
selected this batch via `intake.batchSize`. `$ARGUMENTS` may lead with
`--stale-low-days <days>`, the operator's configured `intake.staleLowDays`;
carry that number into the assembled `context` so the agent's staleness rule
uses it instead of an assumed default. Resolve each issue via
`foreman_linear_read`. Assemble the shared `context` from the two-layer
`Context` digest (§4.7) plus the full batch of resolved items — triage works
on the batch, not a single issue.

Dispatch `foreman-triage` through the `task` tool with `agent: foreman-triage`
and the assembled `context`. The extension revises the call to force
`schemaMode: "strict"`; do not set it yourself and do not try to override it.

Gate: none. Triage is read-only and has no precondition — it runs over
whatever is currently in the Inbox.

Nothing is applied by this dispatch. The agent returns a `TriageProposal`; the
extension writes one proposal comment per item and applies `agent:proposed`.
The operator approves by removing that label or rejects with `reject:
<reason>`. Applying approved proposals happens later, via `/foreman:apply`,
which is extension code — not an agent dispatch.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are also extension code, not agent dispatches; they live in
`src/extension.ts`, not in this commands directory.

Do not restate the triage procedure here — it lives in the
`foreman-triage-inbox` skill, autoloaded by the `foreman-triage` agent.
