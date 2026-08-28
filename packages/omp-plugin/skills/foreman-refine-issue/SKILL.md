---
name: foreman-refine-issue
description: Use when foreman-refine turns one prioritized Backlog or Todo issue into a fully specified, implementation-ready issue.
---

# Foreman Refine Issue

## Preconditions

Priority ≠ `None`. Verify this first and refuse if unprioritized — this is
the enforcement mechanism for "never bulk-refine the backlog." A `legacy`
issue is in scope regardless of the state it sits in (Backlog or Todo); the
label only means "unrefined," and refining it is how it re-enters the funnel.
The extension strips `legacy` when it applies this agent's result.

## Required reads

- The issue: title, description, comments, existing labels.
- The product `Context` doc and the project brief, Definition of Done
  included (§4.7).

## Procedure

1. Verify Priority ≠ `None`. Refuse if unprioritized.
2. Read the product `Context` doc and the project brief, Definition of Done
   included.
3. Draft the description in the `description-template.md` template. Return it
   as `refinedDescription` — never write it to Linear directly.
4. Write acceptance criteria as observable behaviors, verifiable by someone
   who did not write the code. Do not restate the Definition of Done — it is
   per-product, lives in the product `Context` doc, and applies to every
   issue in that product automatically. Repeating it per issue drifts from
   the source and wastes output.
5. Identify affected files and modules via LSP, not guesswork.
6. Estimate the work (see `description-template.md` for the scale). At 5,
   decompose: specify the split in `subIssues[]` with a per-sub-issue
   estimate; the parent becomes a tracking issue and does not get
   `agent:ready`. At 8, this is not an issue — recommend converting it to a
   project or a spike instead of estimating it.
7. If a genuine unknown blocks estimation, specify a `type:spike` in
   `spikeCreated` with a native `blocks` relation to the original issue. See
   `foreman-spike`. Do not guess to force a number.
8. Yield the `RefineResult`.

## Output

Fill `RefineResult` (`schemas/refine-result.json`). The extension applies it:
writes the description, creates sub-issues and the spike if any, applies
`agent:ready`, moves the issue to Todo, and strips `legacy`.

## Stop conditions

A `BlockRecord` is right only when the *intent* of the issue is unrecoverable
from the issue text, the project brief, and the product `Context` doc — not merely under-specified. A
genuine unknown that blocks estimation is a spike, not a block: spin it off
via `spikeCreated` and keep moving. Reserve the block for cases where refining
further would mean guessing at what the operator actually wants.

## Non-goals

- Writing `refinedDescription` into Linear directly — the extension does
  that from the returned result.
- Editing the product `Context` doc or the project brief. Propose edits as a
  comment if something is stale; never write to either.
- Refining issues ahead of what will actually be built next — priority is
  the throttle; refine what the dispatcher hands you, not the whole backlog.
