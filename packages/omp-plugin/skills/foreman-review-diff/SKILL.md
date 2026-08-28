---
name: foreman-review-diff
description: Review a PR diff against its issue's acceptance criteria and the Definition of Done, in a cold context, and yield a ReviewResult.
---

## Preconditions

The review gate hasn't passed yet — that's why you're here. You need a diff to review and a pinned head SHA; the extension fetched both before this dispatch (from the PR, or from `baseBranch..head` when `pr.required: false`) because you hold no git or GitHub tool.

You are running in a **cold context**. Child sessions do not inherit conversation history — this is a structural guarantee, not a convention the implement agent might violate. What does carry over: the workspace tree, the skills, the two-layer `Context` digest (the product `Context` doc and the project brief, §4.7), and the shared `local://` root. Do not go looking for implementation rationale in anything resembling chat history; there isn't any, and its absence is intended, not a gap to route around.

## Required reads

- The diff file at the path given in `context`.
- The issue: acceptance criteria, Out of Scope section.
- The product `Context` doc and the project brief, Definition of Done section included.

## Procedure

1. Read the diff.
2. For each acceptance criterion, verify it's satisfied and cite `file:line` evidence. A criterion you can't point at in the diff is not satisfied — say so, don't guess intent.
3. Check the Definition of Done items from the product `Context` doc against the diff.
4. Check correctness and edge cases in the changed code.
5. Judge test adequacy **by inspection**, not execution — you have no `bash`/`exec`. Ask: would these tests fail if this change were reverted? A test that passes either way isn't covering the behavior it claims to.
6. Assess project organization — structure, module boundaries, naming, placement — as a standing field on every review, not only when something's wrong.
7. Flag scope creep: anything in the diff the acceptance criteria and Out of Scope section didn't ask for.
8. Classify every finding `blocking`, `should-fix`, or `nit` — see `findings.md` for the rubric.
9. Yield the `ReviewResult`, pinning `reviewedSha` to the SHA you were given. This is what makes the fix cycle machine-checkable: the extension re-dispatches review only when the PR's head SHA has no matching `ReviewResult`.

## Output schema

`schemas/review-result.json` — `ReviewResult` branch of the envelope (`blocked: false`, `result` populated, `block: null`).

## Stop conditions

Load `foreman-block-protocol`. Yield a `BlockRecord` instead of a result if:

- The diff file, issue, product `Context` doc, or project brief is missing or unreadable.
- The head SHA you were given doesn't match what's in the diff (stale dispatch).

A disagreement between your review and the implementer's approach is not a stop condition by itself — file it as a finding. Only after two review→fix cycles fail to converge does the issue become `blocked:needs-decision`, and that conversion is the review worker's job (§7.4), not yours to trigger mid-review.

## Non-goals

- No merge authority. You never approve or block a merge directly — the gate reads your findings.
- Never run tests or any code. You have no execution tool; adequacy is judged by inspection.
- Never edit the diff, the issue, or anything else. Read-only everywhere.
- Never re-litigate the acceptance criteria themselves — if they're wrong, that's a refine problem, not something to fix by reviewing against different criteria than the issue states.
