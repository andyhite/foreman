---
description: Triage the Linear Inbox and propose classification, priority, and destination for each item
argument-hint: "[--stale-low-days <days>] <ISSUE-ID...>"
---

<critical>
- Exactly ONE `tasks[]` entry carrying the WHOLE batch. NEVER one entry per issue: triage proposes over the batch as a unit.
- Triage exactly the issues named in `$ARGUMENTS`, never the whole Inbox view; the dispatch already selected this batch via `intake.batchSize`.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the triage procedure; `foreman-triage-inbox` is autoloaded.
</critical>

## Resolve

`$ARGUMENTS`: optional leading `--stale-low-days <days>` (the operator's
`intake.staleLowDays`), then space-separated issue ids (`ENG-101 ENG-102`).
Resolve each via `foreman_linear_read`.

## Gate

None. Triage is read-only.

## Dispatch

One entry, `agent: foreman-triage`. Task text: every resolved item in full,
plus the `--stale-low-days` value so the staleness rule uses it instead of
a default. Shared `context`: the two-layer `Context` digest (product
`Context` doc + project brief) for the items' projects; the extension
appends nothing for triage.

## After

Nothing is applied. `TriageProposal` → extension writes one proposal comment
per item and applies `agent:proposed`. Operator approves by removing that
label or rejects with `reject: <reason>`; `/foreman:apply` applies approved
proposals later.
