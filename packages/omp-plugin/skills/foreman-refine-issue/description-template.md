# Description template

Verbatim, per SPEC §13.1:

```markdown
## Context
<why this exists; link to the Context doc section if relevant>

## Acceptance Criteria
- [ ] <observable behavior, verifiable by someone who didn't write it>

## Affected Areas
<from LSP, not guessed>

## Out of Scope
<explicit non-goals — prevents implement-time scope creep>

## Open Questions
<empty at Todo; anything here means it isn't refined>
```

Do not restate the Definition of Done in `## Context` or anywhere else in the
description — it is per-product and lives in the product `Context` doc.

`## Open Questions` must be **empty** for a refined issue. Anything written
there is a signal that refinement isn't finished — resolve it (read more,
check the product `Context` doc or project brief, or spin off a spike) before
yielding, don't ship an issue with an open question attached.

## Worked example

```markdown
## Context
The triage dedupe pass currently does an exact title match, so near-duplicate
bug reports (e.g. "search times out" vs "search request times out on long
queries") both land in Backlog separately. See Context doc §"Triage quality
signals".

## Acceptance Criteria
- [ ] Two Triage items whose descriptions describe the same defect are
      proposed as `duplicateOf` in the same `TriageProposal` run.
- [ ] A near-duplicate with materially different reproduction scope (e.g. a
      narrower query-length trigger) is proposed as `blocked by`, not
      `duplicateOf`.
- [ ] `severityReasoning` for a proposed duplicate names the specific matched
      issue ID, not a general description.

## Affected Areas
- `packages/omp-plugin/skills/foreman-triage-inbox/dedupe.md`
- `packages/omp-plugin/agents/foreman-triage.md`

## Out of Scope
- Changing the dedupe threshold or introducing embedding-based similarity —
  this issue only fixes the exact-match limitation, not the whole matching
  strategy.
- Retroactively re-triaging already-proposed items.

## Open Questions
```

Note the empty `## Open Questions` — that emptiness is what marks the issue
refined.

## Writing an `## Out of Scope` that actually prevents scope creep

A weak out-of-scope entry restates the acceptance criteria negatively ("don't
implement anything not listed above") — that adds nothing an implementer
doesn't already know. A strong entry names a *specific adjacent temptation*:
a related bug in the same file, a refactor that would make the fix cleaner,
a broader version of the same problem. Naming the temptation is what stops an
implement agent from picking it up as "obviously part of this" — anything
picked up anyway becomes `discoveredWork`, not silently expanded scope.
