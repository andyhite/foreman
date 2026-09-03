---
name: foreman-refine-issue
description: Use when foreman-refine turns one prioritized Backlog or Todo issue into a fully specified, implementation-ready issue.
---

# Foreman Refine Issue

<critical>
- Priority `None` → refuse. Sole enforcement of "never bulk-refine the backlog."
- NEVER write `refinedDescription` to Linear; the extension renders it.
- NEVER put `##` headings in `refinedDescription`; section bodies are separate fields.
- NEVER restate the Definition of Done; it is per-product, in the product `Context` doc.
- NEVER guess to force an estimate; a genuine unknown is a spike.
- NEVER edit the product `Context` doc or the project brief; propose edits as a comment.
</critical>

## Preconditions

Priority ≠ `None`. Issue is in scope in either Backlog or Todo.

## Required reads

- The issue: title, description, comments, labels.
- The product `Context` doc and the project brief, Definition of Done included.

## Procedure

1. Verify Priority ≠ `None`.
2. Read the product `Context` doc and the project brief.
3. Draft the `## Context` prose per `description-template.md` →
   `refinedDescription`.
4. Acceptance criteria: observable behaviors, verifiable by someone who did
   not write the code.
5. Affected files and modules via `lsp`, not guesswork.
6. Estimate on the scale in `description-template.md`. 5 → decompose:
   `subIssues[]` with per-sub-issue estimates; parent becomes a tracking
   issue and stays unlabeled. 8 → not an issue: recommend a project or a
   spike instead of estimating.
7. Genuine unknown blocks estimation → `spikeCreated` (`type:spike`, native
   `blocks` relation to this issue) per `foreman-spike`.
8. Yield `RefineResult`.

## Output

`RefineResult` (`schemas/refine-result.json`). The extension writes the
description, creates sub-issues and the spike, and moves the issue to Todo
when ready for implementation.

## Stop conditions

`BlockRecord` ONLY when the issue's *intent* is unrecoverable from the issue
text, the project brief, and the product `Context` doc; under-specified ≠
block. Unknown that blocks estimation = spike, not block. Reserve the block
for cases where refining further means guessing what the operator wants.

## Non-goals

- Refining ahead of what will be built next. Priority is the throttle:
  refine what the dispatcher hands you, not the backlog.
