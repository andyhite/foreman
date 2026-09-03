---
name: foreman-triage-inbox
description: Use when foreman-triage processes the Linear Triage inbox — classifies, dedupes, and applies routing for each item; the extension applies the result directly.
---

# Foreman Triage Inbox

<critical>
- NEVER apply anything yourself: no issues, sub-issues, spikes, comments, labels, or state changes. You return a `TriageResult`; the extension applies it to Linear.
- Repro by reading only. You hold no exec tool.
- Uncertainty is a finding (`missingInfo`), NEVER a `BlockRecord`.
- `destination` = workflow state; `destinationProjectId` / `newProject` = project. NEVER conflate.
</critical>

## Preconditions

None. Every item in the batch is in scope; no write tool, no gate. Only the
implementation gate downstream cares about `type:`, priority, and estimate.

## Required reads

- Each item: title, description, comments, reporter.
- The existing backlog, for dedupe (`foreman_linear_read`).
- The repo, read-only, for repro: your cwd *is* the checkout for the team
  this batch was drawn from. An item whose code is not found there means
  repro is unavailable for that item, not an error.

## Procedure

Per item, in order:

1. **Classify.** `type:` label: `bug`, `feature`, `chore`, `spike`, `docs`.
2. **Dedupe** against the backlog for semantic duplicates per `dedupe.md`.
3. **Attempt repro** by reading the relevant code paths.
4. **Propose a Priority** (1 Urgent – 4 Low) with `severityReasoning`.
   Un-actioned, clearly low-severity items → recommend `cancel` by default.
5. **Set `app`** from the `FOREMAN-APPS` marker when the item belongs to one
   configured app; `null` when the repo has no apps or the item spans all of
   them.
6. **`missingInfo`** when repro or scoping is incomplete.
7. **`proposedBlockedBy`** where a dependency is evident.
8. **`destination`**: `backlog` | `new-project` | `cancel` | `duplicate`.
9. **Project**: `destinationProjectId` (real Linear id, read via
   `foreman_linear_read`) when `destination` is `backlog` and an existing
   project fits; `null` when the work has no ship moment (the `type:` label
   alone carries it). `newProject` (`name`, `description`, `app`) when
   `destination` is `new-project` and no existing project fits work that
   does have a ship moment; `duplicateOf` (the human identifier it
   duplicates) when `destination` is `duplicate`. Leave the other two null.
10. No usable description → `draftDescription` + `proposedEstimate`; both
    `null` when the existing ones are adequate.

## Output

`TriageResult` (`schemas/triage-result.json`): `items[]` + `summary`. The
extension applies it directly, per item: `backlog` sets priority and
project (or leaves it unset) and moves the issue to Backlog; `new-project`
creates a new project and moves the issue into it; `cancel` and `duplicate`
move the issue to Needs Input and write a block marker asking the operator
to confirm. No proposal, no approval step, no `/foreman:apply`.

## Stop conditions

Essentially none. An item that cannot be classified, reproduced, or deduped
confidently → populated `missingInfo`, inside the result. Triage exists to
surface uncertainty for the operator to resolve at the `cancel`/`duplicate`
block, not to stall on it.

## Non-goals

- Prioritizing the roadmap; that is the operator's weekly pass.
