---
name: foreman-triage-inbox
description: Use when foreman-triage processes the Linear Triage inbox — classifies, dedupes, and proposes routing for each item without applying anything.
---

# Foreman Triage Inbox

## Preconditions

None. Every item in the Inbox view is in scope; the agent holds no write tool
of any kind, so there is no gate to satisfy before running — only the
implementation gate downstream cares about `type:`, priority, and estimate.

## Required reads

- Each Triage item: title, description, comments, reporter.
- The existing backlog, for dedupe comparison (`foreman_linear_read`).
- The repo, read-only, for repro attempts — resolved via the repo map (§3.5).

## Procedure

For each item, in order:

1. **Classify.** Assign a `type:` label (`bug`, `feature`, `chore`, `spike`,
   `docs`).
2. **Dedupe.** Compare against the existing backlog for semantic duplicates.
   See `dedupe.md` for how to judge a match.
3. **Attempt repro, by reading only.** No exec tool is held — confirm or
   refute by reading the relevant code paths, not by running anything.
4. **Propose a Priority** with severity reasoning in `severityReasoning`. An
   un-actioned `Low` item older than 90 days defaults to a `Canceled`
   recommendation.
5. **Flag missing information** in `missingInfo` when repro or scoping is
   incomplete.
6. **Propose `blocked by` relations** in `proposedBlockedBy` where a
   dependency is evident.
7. **Recommend a destination** (`Backlog`, `Canceled`, `Duplicate`).
8. **Assign a project** in `destinationProject`, by name — never a UUID — for
   the issue to land in: a milestone project or the product's standing
   `Maintenance` project. This is a separate axis from `destination` (the
   workflow state) — writing a state name into `destinationProject` is a
   conflation bug. Use `null` only when you genuinely cannot tell which
   project fits.

## Output

Fill `TriageProposal`: `items[]` per the schema
(`schemas/triage-proposal.json`), plus `summary`. Nothing here is applied by
this agent — the extension writes one comment per item (human rendering plus
an embedded machine-readable copy) and applies `agent:proposed`. The operator
approves by removing that label, rejects by replying `reject: <reason>`.
`/foreman-apply` performs the actual mutation later, deterministically, from
the approved comment.

## Stop conditions

Essentially none. This skill produces proposals, not blocks. An item that
can't be classified, reproduced, or deduped confidently is not a block — it is
low `reproConfidence` and populated `missingInfo`, reported as part of the
proposal. A triage agent that yields a `BlockRecord` has misread its job: the
whole point of triage is to surface uncertainty to the operator as a
reviewable proposal, not to stall on it.

## Non-goals

- Applying any proposal (extension code, §7.1).
- Creating issues, sub-issues, or spikes.
- Prioritizing the roadmap — that is the operator's weekly pass.
- Writing to Linear in any form beyond the returned `TriageProposal`.
