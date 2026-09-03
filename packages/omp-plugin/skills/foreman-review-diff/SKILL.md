---
name: foreman-review-diff
description: Review a PR diff against its issue's acceptance criteria and the Definition of Done, in a cold context, and yield a ReviewResult.
---

<critical>
- No merge authority. NEVER approve or block a merge; the gate reads your findings.
- NEVER run tests or code; no execution tool. Adequacy is judged by inspection.
- NEVER edit the diff, the issue, or anything else. Read-only everywhere.
- NEVER re-litigate the acceptance criteria; wrong criteria are a refine problem, not license to review against different ones.
- Cold context: no chat history exists. NEVER hunt for implementation rationale outside the diff, the issue, the product `Context` doc, and the project brief.
</critical>

## Preconditions

Review gate not yet passed. The extension fetched the diff and head SHA
before dispatch (from the PR, or `baseBranch..head` when
`pr.required: false`); you hold no git or GitHub tool. What carries into your
session: the workspace tree, the skills, the product `Context` doc and
project brief, the shared `local://` root.

## Required reads

- The diff at the `FOREMAN-DIFF` path in your task.
- The issue: acceptance criteria, Out of Scope.
- The product `Context` doc and the project brief, Definition of Done included.

## Procedure

1. Read the diff.
2. Per acceptance criterion: satisfied? Cite `file:line`. Not locatable in
   the diff → not satisfied; say so, never guess intent.
3. Check the Definition of Done items against the diff.
4. Check correctness and edge cases in the changed code.
5. Test adequacy by inspection: would these tests fail if the change were
   reverted? A test passing either way covers nothing.
6. Project organization (structure, module boundaries, naming, placement):
   standing field on every review, not only when something is wrong.
7. Scope creep: anything the criteria and Out of Scope did not ask for.
8. Classify every finding `blocking` | `should-fix` | `nit` per
   `findings.md`.
9. Yield `ReviewResult` with `reviewedSha` = the SHA you were given. This
   makes the fix cycle machine-checkable: the extension re-dispatches review
   only when the PR head has no matching `ReviewResult`.

## Output schema

`schemas/review-result.json`: `ReviewResult` branch of the envelope
(`blocked: false`, `result` populated, `block: null`).

## Stop conditions

Load `foreman-block-protocol`; yield a `BlockRecord` when:

- Diff file, issue, product `Context` doc, or project brief missing or
  unreadable.
- Given head SHA does not match the diff (stale dispatch).

Disagreement with the implementer's approach ≠ stop: file a finding. Two
failed review→fix cycles apply `foreman:blocked` with a needs-decision block
record; the review worker triggers that, never you mid-review.
