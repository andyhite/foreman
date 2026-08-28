---
name: foreman-implement-issue
description: Implement a refined issue in its Foreman-managed worktree, open the PR, and yield an ImplementResult.
---

## Preconditions

The implementation gate already passed (`core` `gates/implementation.ts`) before this dispatch — do not re-derive its predicates here. Before touching any file, read the live `foreman:lock` comment via `foreman_linear_read` and confirm its dispatch ID matches this dispatch. If it doesn't match, stop and yield nothing: another run owns this issue. Never claim, refresh, or clear the lock yourself — the dispatcher owns its lifecycle.

## Required reads

- The issue: description, acceptance criteria, Out of Scope section.
- The product `Context` doc and the project brief, Definition of Done section included.
- If the worktree already exists (see Resume, step 2 below): the prior `BlockRecord` or review findings and the operator's reply.

## Procedure

1. **Verify the lock**, per Preconditions. Abort on mismatch.
2. **Resume check.** If the worktree at the path the extension created already contains commits, this is a resume, not a fresh start — see `resume.md` for the detection and continuation procedure. Do this before writing any code; starting fresh over prior work discards it and repeats paid-for effort.
3. **Implement** against the acceptance criteria and the per-product Definition of Done. The criteria are the contract: anything you find that the issue didn't ask for — a bug, a missing test elsewhere, a refactor opportunity — goes in `discoveredWork`, never into this diff. The extension turns each entry into a new Backlog issue with a native relation.
4. **Write tests** covering each acceptance criterion. A criterion with no corresponding test is not done.
5. **Open the PR.** Follow the template in `pr-body.md`. This is the one artifact the extension never renders — get it right now, because there's no second pass. When the repo config sets `pr.required: false`, push the branch instead and leave `prUrl` empty in the result.
6. **Yield the `ImplementResult`**: `issueId`, `branch`, `prUrl` (or empty), `headSha`, `criteriaMet[]` with evidence per criterion, `testsAdded[]`, `discoveredWork[]`, `approachSummary`. The extension moves the issue to In Review, releases the lock, and files `discoveredWork` as new issues.

## Output schema

`schemas/implement-result.json` — `ImplementResult` branch of the envelope (`blocked: false`, `result` populated, `block: null`).

## Stop conditions

Anything that would require asking the operator a question, or that exceeds your authority, is a block, not a question. Load `foreman-block-protocol` and yield a `BlockRecord` instead of the result:

- A dependency surfaces that isn't in `blockedBy` on the issue.
- The acceptance criteria are ambiguous or contradictory and no reasonable reading resolves it.
- You exhaust budget mid-implementation.
- Two review→fix cycles have not converged (you're in resume mode for cycle 3) — this is the review worker's call, but if you land here anyway, block rather than attempt a third cycle.

## Non-goals

- Do not implement anything outside the acceptance criteria; log it as `discoveredWork` instead.
- Do not restate the Definition of Done or the implementation gate here — they're enforced in code.
- Do not merge the PR. No agent has merge authority.
- Do not touch the Linear lock label or state directly. The extension is the sole Linear writer.
