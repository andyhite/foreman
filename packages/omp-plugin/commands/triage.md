---
description: Triage the Linear Inbox and apply classification, priority, and destination for each item
argument-hint: <ISSUE-ID...>
---

<critical>
- Exactly ONE `tasks[]` entry carrying the WHOLE batch. NEVER one entry per issue: triage classifies over the batch as a unit.
- Triage exactly the issues named in `$ARGUMENTS`, never the whole Inbox view; the `plan` loop already selected this batch via `loop.triageBatch`.
- Task text MUST carry `FOREMAN-ISSUES: <ID>,<ID>,...` (comma-separated, no spaces) on its own line, listing exactly the issue ids named in `$ARGUMENTS`. The guard rewrites this line; the extension refuses to apply any result item naming an issue outside it.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the triage procedure; `foreman-triage-inbox` is autoloaded.
- NEVER attempt a project-scoped context read for a Triage item; Triage items have no project.
</critical>

## Resolve

`$ARGUMENTS`: space-separated issue ids (`ENG-101 ENG-102`). Resolve the
whole batch in ONE call: `foreman_linear_read` `op: "issues"` with
`id: "$ARGUMENTS"` and `includeComments: true`. A non-empty `missing` in
the response means the loop named an issue that no longer exists: report
those ids to the operator and triage the rest. NEVER call `op: "issue"`
per id, and NEVER call `op: "issues"` without `id`.

Also read `op: "team_roadmap"`: the candidate projects with their real
ids, statuses, and dependency edges. Also read `op: "context"`: the
product `Context` doc (Definition of Done included) — the only context
available for Triage items, which carry no project of their own.

## Gate

None. Triage is read-only.

## Dispatch

One entry, `agent: foreman-triage`. Task text: `FOREMAN-ISSUES: <ID>,<ID>,...`
listing exactly the issues resolved above, then every resolved item in full.
Shared `context`: the `team_roadmap` output (the candidate projects
`destinationProjectId` must choose from). The extension appends the product
`Context` doc to the shared `context` itself; Triage items carry no
project, so there is no per-item project brief layer.

## After

`TriageResult` → the extension applies it directly, per item. `backlog`
moves the issue to Backlog with priority set and project set when one fits
(`destinationProjectId: null` for `type:bug`/`type:chore` work with no ship
moment) and any `proposedBlockedBy` wired as native `blocks` relations.
`new-project` creates a new project and moves the issue into it. `cancel`
and `duplicate` move the issue to Needs Input and write a block marker
asking the operator to confirm. No approval step, no `/foreman:apply`.
