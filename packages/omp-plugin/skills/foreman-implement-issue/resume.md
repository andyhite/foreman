# Resume procedure

Every loop dispatch is a fresh process; the original agent's session died with
it. A fresh spawn landing in resume mode is the normal continuation path.

Two paths land here:

- **Operator unblock.** `/foreman:unblock <ISSUE-ID>` recorded the reply and
  moved the issue out of Needs Input; the next loop pass re-dispatched implement.
- **Review fix cycle.** A `ReviewResult` carried blocking findings; the
  extension wrote them to the issue and re-dispatched implement against the
  same worktree.

Original agent still alive (interactive or herdr session, `idle`)? A `hub`
message to it is cheaper than reconstructing context. NEVER wait on that:
assume you are a fresh process reading disk and Linear.

## Detection

Worktree contains commits beyond the base branch (`FOREMAN-BASE` line) →
resume.

## Continuation

1. Read the prior `BlockRecord` (Case A/B) or the review findings comment
   (fix cycle) from the issue's Linear comments.
2. Read the operator's reply, if any: the comment `/foreman:unblock` left.
3. Read the partial commits (`git log`, `git diff` against the base).
4. Continue: address the findings or the answer, extend existing work. Re-run
   only tests affected by your changes plus the full suite for the criteria
   you touch.
5. The PR already exists on a fix cycle. Call `foreman_github_pr` with
   `op: "view"` and `head` set to the `FOREMAN-BRANCH` branch, push your new
   commits, and carry that PR's URL into `prUrl`. NEVER call `create` on
   resume.
6. Proceed with `SKILL.md` steps 3–6.

NEVER discard prior commits to "start clean." The worktree is the only record
of that work; the operator paid for it once already.
