---
description: Triage the Linear Inbox and apply classification, priority, and destination for each item
argument-hint: "[--initiatives <id,id,...>] <ISSUE-ID...>"
---

<critical>
- Exactly ONE `tasks[]` entry carrying the WHOLE batch. NEVER one entry per issue: triage classifies over the batch as a unit.
- Triage exactly the issues named in `$ARGUMENTS`, never the whole Inbox view; the `plan` loop already selected this batch via `loop.triageBatch`.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the triage procedure; `foreman-triage-inbox` is autoloaded.
</critical>

## Resolve

`$ARGUMENTS`: optional leading `--initiatives <id,id,...>` (the repo's
initiative ids, for picking a `newProject.initiativeId`), then
space-separated issue ids (`ENG-101 ENG-102`). Resolve each via
`foreman_linear_read`.

## Gate

None. Triage is read-only.

## Dispatch

One entry, `agent: foreman-triage`. Task text: every resolved item in full,
plus the `--initiatives` ids so the agent can pick a `newProject.initiativeId`
when `destination` is `new-project`. Shared `context`: the two-layer `Context`
digest (product `Context` doc + project brief) for the items' projects; the
extension appends nothing for triage.

## After

`TriageResult` → the extension applies it directly, per item. `backlog`
moves the issue to Backlog with priority and project set and any
`proposedBlockedBy` wired as native `blocks` relations. `new-project`
creates a new Backlog-status project and moves the issue into it. `cancel`
and `duplicate` leave the issue in Triage, apply `foreman:blocked`, and
write a `block` marker asking the operator to confirm. No approval step,
no `/foreman:apply`.
