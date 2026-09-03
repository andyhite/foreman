# Description template

The extension renders the stored body:

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
<empty at Ready; anything here means it isn't refined>
```

You return the parts; the extension assembles them in exactly this order:

| Section | Field |
|---|---|
| `## Context` | `refinedDescription`: prose only, no headings |
| `## Acceptance Criteria` | `acceptanceCriteria[]` |
| `## Affected Areas` | `affectedAreas[]` |
| `## Out of Scope` | `outOfScope[]` |
| `## Open Questions` | nothing; always rendered empty |

Headings inside `refinedDescription` nest a second template under
`## Context` and orphan the real criteria where the parser cannot read them.

No open-questions field: a refined issue has none. Resolve an unknown (read
more, check the product `Context` doc or project brief, or spin off a spike)
before yielding.

## Worked example

`refinedDescription`:

```markdown
The triage dedupe pass currently does an exact title match, so near-duplicate
bug reports (e.g. "search times out" vs "search request times out on long
queries") both land in Backlog separately. See Context doc §"Triage quality
signals".
```

`acceptanceCriteria`:

- Two Triage items whose descriptions describe the same defect are marked as
  `duplicateOf` in the same triage pass.
- A near-duplicate with materially different reproduction scope (e.g. a
  narrower query-length trigger) is marked as `blocked by`, not
  `duplicateOf`.
- `severityReasoning` for an applied duplicate names the specific matched
  issue ID, not a general description.

`affectedAreas`:

- `packages/omp-plugin/skills/foreman-triage-inbox/dedupe.md`
- `packages/omp-plugin/agents/foreman-triage.md`

`outOfScope`:

- Changing the dedupe threshold or introducing embedding-based similarity —
  this issue only fixes the exact-match limitation, not the whole matching
  strategy.
- Retroactively re-triaging already-applied items.

Note that no field carries a `##` heading: every heading in the stored issue
comes from the renderer.

## `## Out of Scope` that prevents scope creep

Weak entry: negates the criteria ("don't implement anything not listed
above"); adds nothing. Strong entry: names a *specific adjacent temptation*
(a related bug in the same file, a refactor that would make the fix cleaner,
a broader version of the same problem). Naming the temptation stops an
implement agent from treating it as "obviously part of this"; anything picked
up anyway becomes `discoveredWork`.
