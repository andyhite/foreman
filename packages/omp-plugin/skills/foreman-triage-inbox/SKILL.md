---
name: foreman-triage-inbox
description: Use when foreman-triage processes the Linear Triage inbox — classifies, dedupes, and proposes routing for each item without applying anything.
---

# Foreman Triage Inbox

<critical>
- NEVER apply anything: no issues, sub-issues, spikes, comments, labels, or state changes. You return a `TriageProposal`; nothing else reaches Linear.
- Repro by reading only. You hold no exec tool.
- Uncertainty is a finding (`reproConfidence`, `missingInfo`), NEVER a `BlockRecord`.
- `destination` = workflow state; `destinationProject` / `destinationProjectId` = project. NEVER conflate.
</critical>

## Preconditions

None. Every item in the batch is in scope; no write tool, no gate. Only the
implementation gate downstream cares about `type:`, priority, and estimate.

## Required reads

- Each item: title, description, comments, reporter.
- The existing backlog, for dedupe (`foreman_linear_read`).
- The repo, read-only, for repro: your cwd's `repos/index.json` maps each
  item's identifier to a `repos/<alias>` symlink (a real checkout) when its
  initiative resolves to a registered repo; a `null` entry means it doesn't
  — treat repro as unavailable for that item, not an error.

## Procedure

Per item, in order:

1. **Classify.** `type:` label: `bug`, `feature`, `chore`, `spike`, `docs`.
2. **Dedupe** against the backlog for semantic duplicates per `dedupe.md`.
3. **Attempt repro** by reading the relevant code paths.
4. **Propose a Priority** with `severityReasoning`. Un-actioned `Low` older
   than the dispatch's `--stale-low-days` (operator's `intake.staleLowDays`,
   default 90) → recommend `Canceled` by default.
5. **`missingInfo`** when repro or scoping is incomplete.
6. **`proposedBlockedBy`** where a dependency is evident.
7. **`destination`**: `Backlog` | `Canceled` | `Duplicate`.
8. **Project**: `destinationProjectId` (real Linear id, read via
   `foreman_linear_read`) when resolvable, else `destinationProject` (a name,
   never a UUID): a milestone project or the product's standing
   `Maintenance` project. `null` only when you genuinely cannot tell.
9. No usable description → `draftDescription` + `proposedEstimate`; both
   `null` when the existing ones are adequate.

## Output

`TriageProposal` (`schemas/triage-proposal.json`): `items[]` + `summary`. The
extension writes one comment per item (human rendering + embedded
machine-readable copy) and applies `agent:proposed`. Operator approves by
removing that label, rejects by replying `reject: <reason>`; `/foreman:apply`
performs the mutation later, deterministically, from the approved comment.

## Stop conditions

Essentially none. An item that cannot be classified, reproduced, or deduped
confidently → low `reproConfidence` + populated `missingInfo`, inside the
proposal. Triage exists to surface uncertainty as a reviewable proposal, not
to stall on it.

## Non-goals

- Prioritizing the roadmap; that is the operator's weekly pass.
