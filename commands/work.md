---
description: Deliver a task or bug issue end to end (dev loop)
argument-hint: "<issue-number>"
---

Deliver issue #$1 end to end.

Read `skill://dev-loop`, `skill://tracker`, `skill://worktree`, and
`skill://verification`, then execute the dev loop exactly as written:
preflight and claim, worktree, context, plan (dispatch the `planner` agent
for anything non-trivial), omp todos, TDD implementation orchestrated
through subagents, the verification ladder, the `qa` agent gate looped to
PASS, PR, review wait, post-merge cleanup, board moves.

Two checks before you start: if #$1 is labeled `epic`, stop and tell me to
use `/omp-foreman:orchestrate $1` instead; if it is not at `To Do` (or carries
an untriaged bug label), stop and tell me what state it is actually in —
do not work around the lifecycle.

You are the orchestrator: subagents search and edit, you own sequencing,
verification, and delivery. **You never merge**: I merge the PR — that is
the approval — and my comments on it are change requests to address and
return to `Review`. When the PR is open and ready, tell me and yield; pick
the loop back up when I merge or comment. Report at the end: PR, what
shipped, how it was proven, board state, worktree removed.
