# Description template

The extension renders the stored body, per SPEC §13.1:

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

You do not write that markdown. You return its parts, and the extension
assembles them in exactly this order:

| Section | Field |
|---|---|
| `## Context` | `refinedDescription` — prose only, no headings |
| `## Acceptance Criteria` | `acceptanceCriteria[]` |
| `## Affected Areas` | `affectedAreas[]` |
| `## Out of Scope` | `outOfScope[]` |
| `## Open Questions` | nothing — always rendered empty |

Putting the headings in `refinedDescription` nests a second copy of the
template inside the `## Context` section, and leaves the real acceptance
criteria orphaned where the parser cannot read them back.

Do not restate the Definition of Done in `refinedDescription` or anywhere else
in the description — it is per-product and lives in the product `Context` doc.

There is no open-questions field: a refined issue has none. An unresolved
unknown is not something to park in the body — resolve it (read more, check
the product `Context` doc or project brief, or spin off a spike) before
yielding.

## Worked example

`refinedDescription`:

```markdown
The triage dedupe pass currently does an exact title match, so near-duplicate
bug reports (e.g. "search times out" vs "search request times out on long
queries") both land in Backlog separately. See Context doc §"Triage quality
signals".
```

`acceptanceCriteria`:

- Two Triage items whose descriptions describe the same defect are proposed as
  `duplicateOf` in the same `TriageProposal` run.
- A near-duplicate with materially different reproduction scope (e.g. a
  narrower query-length trigger) is proposed as `blocked by`, not
  `duplicateOf`.
- `severityReasoning` for a proposed duplicate names the specific matched
  issue ID, not a general description.

`affectedAreas`:

- `packages/omp-plugin/skills/foreman-triage-inbox/dedupe.md`
- `packages/omp-plugin/agents/foreman-triage.md`

`outOfScope`:

- Changing the dedupe threshold or introducing embedding-based similarity —
  this issue only fixes the exact-match limitation, not the whole matching
  strategy.
- Retroactively re-triaging already-proposed items.

Note that no field carries a `##` heading: every heading in the stored issue
comes from the renderer.

## Writing an `## Out of Scope` that actually prevents scope creep

A weak out-of-scope entry restates the acceptance criteria negatively ("don't
implement anything not listed above") — that adds nothing an implementer
doesn't already know. A strong entry names a *specific adjacent temptation*:
a related bug in the same file, a refactor that would make the fix cleaner,
a broader version of the same problem. Naming the temptation is what stops an
implement agent from picking it up as "obviously part of this" — anything
picked up anyway becomes `discoveredWork`, not silently expanded scope.
