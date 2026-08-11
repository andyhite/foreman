---
name: dev-loop
description: The end-to-end foreman development loop for a single task or bug issue, run inside a worktree the orchestrator provisioned — verify the claim, plan, TDD implementation via subagents, verification ladder, QA gate, PR, review, merge, board moves. Read when delivering a dispatched To Do issue.
---

# Dev loop — from `To Do` to `Done`, one issue

You **deliver** this issue; you are not its typist. You own context,
sequencing, verification, and delivery; subagents do the searching and the
editing. Related skills: `tracker` (every status/label move), `worktree`
(branch + worktree), `verification` (the check ladder).

## 0. Preflight — verify your provisioned assignment

- `.omp/foreman.json` exists — if not, stop and tell your orchestrator to
  run `/foreman:init` first (`skill://bootstrap`).
- Your brief names the issue, the branch, and — for an in-process
  subagent — the worktree path your orchestrator provisioned; this loop
  runs inside that checkout, and you never create one. A **fleet worker**
  (a separate omp dispatched through the `fleet` CLI) was started *in*
  its worktree before the path existed to name: your checkout is your own
  `$PWD` — assert it is a non-primary worktree on the named branch, and
  identify yourself to your boss by fleet handle, not by path. Issue or
  branch missing from the brief? Ask before touching anything — `hub` as
  a subagent, `fleet reply` as a fleet worker.
- The issue is open, labeled task or bug (with a severity), and claimed for
  you: board status is `In Progress`, and the `worktree` skill's
  `claim-check <issue>` operation reports exactly the worktree you were
  handed — the brief's path, or your own `$PWD` under fleet. A mismatch —
  a different worktree, a different writer, a status
  that isn't `In Progress` — goes back to your orchestrator, never around
  it. An epic in the brief is a dispatch error: epics are partitioned by
  the orchestration loop (`skill://epic-loop`), not delivered whole.

## 1. Worktree — provided, asserted, never created

Your worktree exists before you do: the orchestrator claimed the issue and
invoked the `worktree` skill's `create` operation under
`policy.worktree.strategy` (`.omp/foreman.json`, default `git`) — or, for
a fleet worker, `fleet spawn` created it and started you inside it.
Assert it: the checkout (the brief's path, or your `$PWD` under fleet)
exists, sits on the branch
`<type>/<issue>-<slug>` you were assigned, and has dependencies installed —
run `commands.install` if the strategy's setup did not. Every edit for
this issue happens here: never the primary checkout, never a sibling's
worktree, and never a second worktree you create yourself.

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

`policy.plan.planner` (`.omp/foreman.json`, default `non-trivial`)
decides whether to dispatch the `planner` agent:

| Value | Plan procedure |
| --- | --- |
| `non-trivial` | Dispatch `planner` unless the change is genuinely trivial (one file, obvious fix); write a short inline plan for that exception. This is today's behavior. |
| `always` | Dispatch `planner` for every issue. |
| `never` | Do not dispatch `planner`; write the plan inline yourself. |

Every setting still produces a written plan naming the steps in order, the
files each step touches, the test that proves each step, and the risks.
Sanity-check it yourself — you own it once you accept it. If it reveals the
"task" is not tiny, stop: take it back to grooming to become an epic rather
than silently delivering a big bang. That rule holds at every setting.

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
  self-contained: files, acceptance criteria, and **skip
  formatters/linters/project-wide suites** (you run those).
- `policy.tdd.enforcement` (`.omp/foreman.json`, default `required`)
  decides how test-first applies:

  | Value | Implementation procedure |
  | --- | --- |
  | `required` | Today's rule: use `skill://tdd`; write the test, watch it fail for the right reason, implement, then watch it pass. |
  | `encouraged` | Test-first remains mandatory for new behavior and bug fixes; a bug fix still starts from a reproduction. For refactors and plumbing, choose the proportionate proof. |

  Neither value permits shipping unproven behavior. New behavior gets a test
  that would catch its plausible regression; the one rule that changes
  behavior remains: no test gets written at an unconfirmed seam. The seam
  comes from the issue's `## Test seams` section, agreed at grooming; if the
  issue has none — an older issue, or one that said the seam could not be
  named yet — confirm it with the operator before the first test instead of
  inventing one silently. `skill://codebase-design` has the vocabulary for
  placing or moving a seam.
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

`policy.qa.gate` (`.omp/foreman.json`, default `required`) decides whether
QA loops:

| Value | QA procedure |
| --- | --- |
| `required` | Dispatch `qa` with the issue number, worktree path, branch, what you built, and how you exercised it. QA independently reviews the diff, runs its own checks, exercises the change, and writes missing e2e coverage. `BLOCKERS` means fix them, re-run the gate, and re-dispatch until `PASS`; disagreements go to the operator. This is today's loop-to-`PASS`. |
| `advisory` | Dispatch QA once with the same brief, record its verdict on the PR, and do not loop. Report every Spec blocker to the operator; never silently drop it. |
| `off` | Do not dispatch QA. Rung 3 verification in step 7 remains mandatory: `off` removes the second reviewer, not the proof. |

Review and commit QA e2e additions on the branch. When QA was dispatched,
mark the `QA` todo `done` in that same turn; record the verdict on the PR in
step 9. Under `off`, complete its tracking item only after step 7's rung 3
proof is verified.

## 9. Pull request

- Rebase onto fresh `origin/<mainBranch>`; re-run the pre-PR gate if the
  rebase pulled in real changes; push.
- Open the PR: title is a Conventional Commit header for the squashed
  result (a squash merge takes it as the commit subject); body says what
  changed, why, how it was exercised (the proof from step 7), and `Closes
  #<issue>`.
- Record the QA verdict as a PR comment when QA was dispatched (who
  reviewed, what was checked, and `PASS` or `BLOCKERS`).
- Move the issue to `Review`; mark the `PR` todo `done` now.
- Under an epic, `policy.delivery.prStrategy` (`.omp/foreman.json`, default
  `stacked`) makes a chained subtask a stack layer under `stacked`, today's
  behavior, or a plain PR off the main branch under `sequential`; see
  `skill://stacked-prs` for the chain detail.

## 10. Review — delivery policy decides who presses merge

`policy.delivery.mergePolicy` (`.omp/foreman.json`, default `operator`)
decides who presses merge; the PR remains the only landing path at both
settings.

| Value | Merge procedure |
| --- | --- |
| `operator` | The operator merging the PR is the approval; an operator comment is a change request. An explicit "merge it" from the operator is the same approval executed by your hands — `gh pr merge --squash`, then step 11. There is no approve-then-merge two-step. This is today's behavior. |
| `agent-on-green` | You may merge your own PR only after CI is green, QA returned `PASS`, and no operator comment remains unresolved. When combined with `policy.qa.gate: off`, CI green is the whole bar because no QA verdict exists; this is the loosest reachable configuration. |

- Watch CI (`github` tool `run_watch`). Red checks are yours to fix
  immediately.
- Then poll `gh pr view <n> --json state,mergedAt,comments,reviews` every
  few minutes, backing off toward ~10 when quiet.
  - **A comment you did not post** (you know which are yours; ignore CI
    bots) → change request at either setting: issue back to `In Progress`,
    address every point with a fix or an evidence-backed reply on the PR,
    re-run the gates (7–8 if code changed), push, reply on the PR that it is
    addressed, issue back to `Review`, resume waiting.
  - **Merged** → step 11.
  - **Closed unmerged** → the operator declined it: comment the state on
    the issue, ask where it should go, and stop.
- Under `agent-on-green`, once the stated bar is met, merge through the PR
  and continue to step 11; never force an outcome.
- Keep it mergeable while you wait: if the main branch moves under the PR
  into conflict, rebase onto `origin/<mainBranch>` and `git push
  --force-with-lease`. If the rebase itself conflicts,
  `skill://resolving-merge-conflicts` is the procedure — never `--abort`
  your way out, and never invent behavior to make a hunk compile.
- Interactive session: tell the operator the PR is ready and yield rather
  than poll forever. Subagent: report the PR to your parent via `hub`,
  then keep polling with backoff. Fleet worker: `hub` does not reach your
  boss — surface the ready PR and any question with `fleet reply`, and
  carry the outcome in your final report.

## 11. After the merge

1. The PR merged — squash or fast-forward, the main branch stays linear
   either way.
2. `Closes #` closed the issue; set the board status to `Done` explicitly.
3. Delete the remote branch if the merge didn't; report the worktree's
   state (clean, branch merged) to your orchestrator — retiring it is the
   orchestrator's `remove` operation to run, never yours. The task is not
   complete while its worktree exists; that completion lands on whoever
   provisioned it.
4. Mark every remaining todo `done` — if any step's todo is still open
   here, that step's work was never actually verified; go back and verify
   it before reporting, don't just close the list to match the outcome.
5. Report: issue, PR, what shipped, how it was proven.

## Blocked?

The moment a blocker is real: comment it on the issue (`tracker` skill),
tell the operator (or your parent orchestrator — via `hub` as a subagent,
via `fleet reply` as a fleet worker), and stop burning
effort on the blocked path. Never park an issue silently.
