---
name: dev-loop
description: The end-to-end foreman development loop for a single task or bug issue — claim, worktree, plan, TDD implementation via subagents, verification ladder, QA gate, PR, review, merge, cleanup. Read when picking up any To Do issue.
---

# Dev loop — from `To Do` to `Done`, one issue

You are the **orchestrator** of this issue, not its typist. You own context,
sequencing, verification, and delivery; subagents do the searching and the
editing. Related skills: `tracker` (every status/label move), `worktree`
(branch + worktree), `verification` (the check ladder).

## 0. Preflight and claim

- `.omp/foreman.json` exists — if not, run `/omp-foreman:init` first (`skill://bootstrap`).
- The issue is open, labeled task or bug (with a severity), and its status
  is `To Do`. Anything else stops here: an epic goes to the `epic-loop`
  skill; a `Backlog` item needs grooming or an explicit operator say-so; an
  untriaged bug needs triage first.
- Nobody else has it: status is not `In Progress`, and no `<issue>-` branch
  or `<repo-slug>-<issue>-` worktree exists.
- **Claim it**: move status to `In Progress` (tracker skill) — before any
  other work.

## 1. Worktree

Create the branch and worktree per the `worktree` skill; install
dependencies the repo's way.

## 2. Context

Read, in order: the issue body and all comments; the parent epic (title,
body, sibling subtasks) if there is one; this project's spec/design docs the
issue references — check `docs/`, a linked doc, or an `AGENTS.md`/`README`
pointer for where those live; any other docs the issue touches. If the issue
contradicts the spec, stop and raise it on the issue — the spec wins until
amended.

## 3. Plan

Dispatch the `planner` agent with the issue number, the epic context, and
anything you learned. For a genuinely trivial change (one file, obvious fix)
a short inline plan is fine. The plan must name: the steps in order, the
files each step touches, the test that proves each step, and the risks.

Sanity-check the plan yourself — you own it once you accept it. If the plan
reveals the "task" is not tiny, stop: take it back to grooming to become an
epic rather than silently delivering a big bang.

## 4. Track

`todo init` with the plan: one omp todo per step, plus a `Verification`
phase (pre-PR gate, QA) and a `Delivery` phase (PR, review, merge,
cleanup). Keep it moving as you go — todos are your working memory, the
board is the world's.

## 5. Implement — TDD, orchestrated

For each step (batch independent steps into one `task` dispatch):

- Delegate to subagents: `fanout` for well-scoped mechanical slices, `task`
  for judgment-heavy ones, `scout` for read-only investigation. Each brief is
  self-contained: files, the failing-test-first contract, acceptance
  criteria, and **skip formatters/linters/project-wide suites** (you run
  those).
- **Test first.** The subagent writes the test, watches it fail for the
  right reason, implements, watches it pass. New behavior gets a test that
  would catch its plausible regression; a bug fix starts from a
  reproduction.
- Verify each result yourself with rung 1 of the `verification` skill (LSP
  diagnostics, per-file lint, the step's test file). A subagent's
  "completed" is a claim, not a fact.
- After each coherent slice, rung 2 (package/workspace-scoped check).
- Commit as you go: Conventional Commits, one logical change per commit.

House rules that bind every step: if the repo centralizes rule/validation
predicates somewhere (check its own docs for the convention), extend that,
never re-derive one at a call site; never truncate content silently; don't
hand-edit generated files.

## 6. Pre-PR gate

Rung 3 of the `verification` skill: format, the repo's full verify script,
e2e when it applies, and **exercise the change** — the observed behavior is
the proof, and it goes in the PR body.

## 7. QA gate

Dispatch the `qa` agent with: issue number, worktree path, branch, what you
built, and how you exercised it. QA independently reviews the diff, runs its
own checks, exercises the change, and writes any missing e2e coverage.

- `BLOCKERS` back → fix them (yourself or via subagents), re-run the gate,
  re-dispatch QA. Loop until `PASS`. Disagreements you can't resolve go to
  the operator, not into the PR.
- QA's e2e additions get reviewed by you and committed on the branch.

## 8. Pull request

- Rebase onto fresh `origin/<mainBranch>`; re-run the pre-PR gate if the
  rebase pulled in real changes; push.
- Open the PR: title is a Conventional Commit header for the squashed
  result (a squash merge takes it as the commit subject); body says what
  changed, why, how it was exercised (the proof from step 6), and `Closes
  #<issue>`.
- Record the QA verdict as a PR comment (who reviewed, what was checked,
  `PASS`).
- Move the issue to `Review`.
- Under an epic, a chained subtask's PR is a stack layer instead — same
  gates, different plumbing: see `skill://stacked-prs`.

## 9. Review — the operator decides on the PR itself

You never merge on your own judgment. **The operator merging the PR is the
approval; the operator commenting on it is a change request.** An explicit
"merge it" from the operator is the same approval executed by your hands —
`gh pr merge --squash`, then step 10. There is no approve-then-merge
two-step.

- Watch CI (`github` tool `run_watch`). Red checks are yours to fix
  immediately.
- Then poll `gh pr view <n> --json state,mergedAt,comments,reviews` every
  few minutes, backing off toward ~10 when quiet.
  - **A comment you did not post** (you know which are yours; ignore CI
    bots) → change request: issue back to `In Progress`, address every
    point with a fix or an evidence-backed reply on the PR, re-run the
    gates (6–7 if code changed), push, reply on the PR that it is
    addressed, issue back to `Review`, resume waiting.
  - **Merged** → step 10.
  - **Closed unmerged** → the operator declined it: comment the state on
    the issue, ask where it should go, and stop.
- Keep it mergeable while you wait: if the main branch moves under the PR
  into conflict, rebase onto `origin/<mainBranch>` and `git push
  --force-with-lease`.
- Interactive session: tell the operator the PR is ready and yield rather
  than poll forever. Subagent: report the PR to your parent via `hub`, then
  keep polling with backoff.

## 10. After the merge

1. The operator merged — squash or fast-forward, the main branch stays
   linear either way.
2. `Closes #` closed the issue; set the board status to `Done` explicitly.
3. Delete the remote branch if the merge didn't; remove the worktree and
   local branch (`worktree` skill). The task is not complete while the
   worktree exists.
4. Report: issue, PR, what shipped, how it was proven.

## Blocked?

The moment a blocker is real: comment it on the issue (`tracker` skill),
tell the operator (or your parent orchestrator via `hub`), and stop burning
effort on the blocked path. Never park an issue silently.
