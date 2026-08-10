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

- `.omp/foreman.json` exists — if not, run `/foreman:init` first (`skill://bootstrap`).
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
body, sibling subtasks) if there is one; the domain glossary at
`docs.context`, or the relevant glossaries reached through
`docs.contextMap`, and the ADRs under `docs.adr` that touch the area you're
changing. Read every path from `.omp/foreman.json`; see
`skill://domain-modeling` for the formats. Any of those config paths may be
`null`, which means the repo has none — that's normal, never flag it. Read
any other docs the issue touches. If the issue contradicts the spec, stop and
raise it on the issue — the spec wins until amended. A change that
contradicts a recorded ADR is an amendment to raise, not a feature to build
quietly over the decision.

## 3. Diagnose — bugs only

When the issue carries the bug label, run `skill://diagnosing-bugs` before
dispatching the planner. Its Phase 1 gate — a reproduction command that is
red-capable, deterministic, fast, and agent-runnable — has to be met first;
if you catch yourself reading code to build a theory before that command
exists, stop and go build the command instead.

That command earns its place: it's the regression test's first draft, it's
how you'll know the fix worked instead of believing it did, and it's what QA
re-runs independently in step 8. Post it as a comment on the issue so QA and
the operator can run it too.

A task issue skips this step.

## 4. Plan

Dispatch the `planner` agent with the issue number, the epic context, and
anything you learned. For a genuinely trivial change (one file, obvious fix)
a short inline plan is fine. The plan must name: the steps in order, the
files each step touches, the test that proves each step, and the risks.

Sanity-check the plan yourself — you own it once you accept it. If the plan
reveals the "task" is not tiny, stop: take it back to grooming to become an
epic rather than silently delivering a big bang.

## 5. Track

`todo init` with the plan: one omp todo per step, plus a `Verification`
phase (pre-PR gate, QA) and a `Delivery` phase (PR, review, merge,
cleanup). This list is not a one-time artifact — it's your working
memory for the rest of the loop, and it is **only useful if it tracks
reality as you go**: mark each item `done` the moment its work is
verified, in the same turn as that verification, never batched for the
end. A todo list that's still all-open when you report the issue shipped
means you didn't actually check anything off while doing the work — that's
a process failure, not a cosmetic one.

## 6. Implement — TDD, orchestrated

For each step (batch independent steps into one `task` dispatch):

- Delegate to subagents: `fanout` for well-scoped mechanical slices, `task`
  for judgment-heavy ones, `scout` for read-only investigation. Each brief is
  self-contained: files, the failing-test-first contract, acceptance
  criteria, and **skip formatters/linters/project-wide suites** (you run
  those).
- **Test first.** `skill://tdd` is the governing reference for what makes a
  test worth keeping; the subagent writes the test, watches it fail for
  the right reason, implements, watches it pass. New behavior gets a test
  that would catch its plausible regression; a bug fix starts from a
  reproduction. The one rule that changes behavior: no test gets written
  at an unconfirmed seam. The seam comes from the issue's `## Test seams`
  section, agreed at grooming; if the issue has none — an older issue, or
  one that said the seam couldn't be named yet — confirm it with the
  operator before the first test instead of inventing one silently.
  `skill://codebase-design` has the vocabulary for placing or moving a
  seam.
- Verify each result yourself with rung 1 of the `verification` skill (LSP
  diagnostics, per-file lint, the step's test file). A subagent's
  "completed" is a claim, not a fact.
- After each coherent slice, rung 2 (package/workspace-scoped check), then
  mark that step's todo `done` immediately — the check passing and the
  todo flipping happen together, not "I'll clean up the list later."
- Commit as you go: Conventional Commits, one logical change per commit.

House rules that bind every step: if the repo centralizes rule/validation
predicates somewhere (check its own docs for the convention), extend that,
never re-derive one at a call site; never truncate content silently; don't
hand-edit generated files.

## 7. Pre-PR gate

Rung 3 of the `verification` skill: format, the repo's full verify script,
e2e when it applies, and **exercise the change** — the observed behavior is
the proof, and it goes in the PR body.

## 8. QA gate

Dispatch the `qa` agent with: issue number, worktree path, branch, what you
built, and how you exercised it. QA independently reviews the diff, runs its
own checks, exercises the change, and writes any missing e2e coverage.

- `BLOCKERS` back → fix them (yourself or via subagents), re-run the gate,
  re-dispatch QA. Loop until `PASS`. Disagreements you can't resolve go to
  the operator, not into the PR.
- QA's e2e additions get reviewed by you and committed on the branch.
- `PASS` → mark the `QA` todo `done` now, in this same turn, before
  opening the PR.

## 9. Pull request

- Rebase onto fresh `origin/<mainBranch>`; re-run the pre-PR gate if the
  rebase pulled in real changes; push.
- Open the PR: title is a Conventional Commit header for the squashed
  result (a squash merge takes it as the commit subject); body says what
  changed, why, how it was exercised (the proof from step 7), and `Closes
  #<issue>`.
- Record the QA verdict as a PR comment (who reviewed, what was checked,
  `PASS`).
- Move the issue to `Review`; mark the `PR` todo `done` now.
- Under an epic, a chained subtask's PR is a stack layer instead — same
  gates, different plumbing: see `skill://stacked-prs`.

## 10. Review — the operator decides on the PR itself

You never merge on your own judgment. **The operator merging the PR is the
approval; the operator commenting on it is a change request.** An explicit
"merge it" from the operator is the same approval executed by your hands —
`gh pr merge --squash`, then step 11. There is no approve-then-merge
two-step.

- Watch CI (`github` tool `run_watch`). Red checks are yours to fix
  immediately.
- Then poll `gh pr view <n> --json state,mergedAt,comments,reviews` every
  few minutes, backing off toward ~10 when quiet.
  - **A comment you did not post** (you know which are yours; ignore CI
    bots) → change request: issue back to `In Progress`, address every
    point with a fix or an evidence-backed reply on the PR, re-run the
    gates (7–8 if code changed), push, reply on the PR that it is
    addressed, issue back to `Review`, resume waiting.
  - **Merged** → step 11.
  - **Closed unmerged** → the operator declined it: comment the state on
    the issue, ask where it should go, and stop.
- Keep it mergeable while you wait: if the main branch moves under the PR
  into conflict, rebase onto `origin/<mainBranch>` and `git push
  --force-with-lease`. If the rebase itself conflicts,
  `skill://resolving-merge-conflicts` is the procedure — never `--abort`
  your way out, and never invent behavior to make a hunk compile.
- Interactive session: tell the operator the PR is ready and yield rather
  than poll forever. Subagent: report the PR to your parent via `hub`, then
  keep polling with backoff.

## 11. After the merge

1. The operator merged — squash or fast-forward, the main branch stays
   linear either way.
2. `Closes #` closed the issue; set the board status to `Done` explicitly.
3. Delete the remote branch if the merge didn't; remove the worktree and
   local branch (`worktree` skill). The task is not complete while the
   worktree exists.
4. Mark every remaining todo `done` — if any step's todo is still open
   here, that step's work was never actually verified; go back and verify
   it before reporting, don't just close the list to match the outcome.
5. Report: issue, PR, what shipped, how it was proven.

## Blocked?

The moment a blocker is real: comment it on the issue (`tracker` skill),
tell the operator (or your parent orchestrator via `hub`), and stop burning
effort on the blocked path. Never park an issue silently.
