---
name: stacked-prs
description: Delivering a chain of dependent subtasks as GitHub stacked pull requests under the foreman workflow — gh stack mechanics, layer-per-issue conventions, fixing a mid-stack layer on a change request, operator merge semantics, and the fallback when the feature is unavailable. Read when an epic track has two or more chained subtasks.
---

# Stacked PRs — a dependency chain ships as one stack

`policy.delivery.prStrategy` (`.omp/foreman.json`, default `stacked`)
selects this skill. Under `stacked`, GitHub stacked pull requests turn a
chain of dependent branches into linked PRs: each layer targets the branch
below it, reviewers see one focused diff per layer, and GitHub handles the
cascading rebases and retargeting as layers land. That maps one-to-one onto
an epic **track**: a run of subtasks where each depends on the previous one
— the worker keeps building upward instead of waiting for merges.

Under `sequential`, the chain ships as plain sequential PRs and
`epic-loop` never reaches this skill: dispatch each layer only after the
previous layer merges. The same wave model is also the forced path when
`stacked` is selected but `gh stack` is unavailable. One path is chosen by
policy; the other is forced by capability. A repository that repeatedly
hits that fallback must set `policy.delivery.prStrategy` to `sequential`
deliberately rather than relying on an error path — a fallback that fires
every run is configuration nobody wrote down.

The merge protocol differs by `policy.delivery.mergePolicy`
(`.omp/foreman.json`, default `operator`), as described in “While the
stack is open.”

## Prerequisites — check, don't assume

- `gh extension list | grep gh-stack` (install: `gh extension install
  github/gh-stack`).
- The feature may be preview/subject to change on some GitHub plans: if any
  `gh stack` command fails as unavailable, use the same sequential wave
  model selected by `policy.delivery.prStrategy: sequential`: deliver the
  chain as plain PRs, each dispatched only after the previous one merges,
  and tell the operator that capability forced the selected mechanism.

## Conventions

- One **track = one worker = one worktree = one stack**. The track
  worktree is provisioned by the orchestrator through `skill://worktree`'s
  `create` operation and arrives in the worker's brief; its name is
  `<repo-slug>-<epic>-<track-slug>`. The worker never creates it. Each
  layer's branch keeps the normal issue convention `<type>/<issue>-<slug>`.
- One **layer = one subtask issue = one PR**. Every layer passes the full
  inner dev loop (TDD, verification rungs 1–2, QA gate on the layer's diff)
  before it is submitted. The layer's QA diff is `git diff
  <parent-branch>...HEAD` — the layer only, not the whole stack.
- Board statuses per layer are unchanged: `In Progress` while building,
  `Review` when its PR is open and ready, `Done` when the operator merges
  it.

## Build the stack

```sh
# in the track worktree, on the first layer's branch (based on origin/<mainBranch>)
gh stack init <type>/<issue1>-<slug>       # adopts the current branch, enables rerere
# ... dev loop for layer 1: TDD, verification, QA ...
gh stack submit --auto                      # push + draft PR + stack object on GitHub
gh pr edit <pr1> --title "<conventional header>" --body "<what/why/proof> ... Closes #<issue1>"
gh pr ready <pr1>                           # now move issue 1 to Review

gh stack add <type>/<issue2>-<slug>        # next layer, branched from layer 1's tip
# ... dev loop for layer 2 ...
gh stack submit --auto                      # creates PR 2 with base = layer 1's branch
gh pr edit <pr2> --title ... --body "... Closes #<issue2>" && gh pr ready <pr2>
# ... repeat upward ...
```

- `gh stack submit --auto` is the non-interactive path: it creates missing
  PRs as **drafts** with generated titles — always follow with `gh pr edit`
  (the title becomes the squash commit subject) and `gh pr ready`.
- `gh stack view --json` is the machine-readable stack state; use it
  instead of scraping.
- Rung-3 verification (the repo's full verify script, e2e, exercising
  behavior) at the top of the stack exercises **all layers combined** —
  that is the track's pre-merge integration test. Run it before submitting
  each new top.

## While the stack is open

Poll like the dev loop (`gh pr view` per open layer), plus `gh stack sync`
after anything lands:

- **Operator merges layer(s)** — always bottom-up; a mid-stack merge takes
  everything below it. Move each merged layer's issue to `Done`. Then `gh
  stack sync --prune`: trunk fast-forwards, remaining layers rebase and
  retarget the main branch automatically, merged local branches are
  deleted.
- **Operator comments on layer K** — change request for that layer only:
  issue K back to `In Progress`; fix **on layer K's branch**; then `gh
  stack rebase` (cascades the fix up through K+1…top; `--continue`
  after resolving any conflict — see "Conflicts during a cascade"
  below) and `gh stack push`; re-run the gate for every layer above K,
  not just the top-of-stack verification — a clean rebase of layer
  N+1 says nothing about whether layer N+2 still passes; reply on the
  PR; issue K back to `Review`.
- **The main branch moved underneath** — `gh stack sync` (fetch, trunk
  fast-forward, cascade rebase, force-with-lease push). Non-interactive
  sync aborts on a genuinely diverged stack instead of guessing — resolve
  divergence deliberately (`gh stack unstack` + `gh stack init` to rebuild
  tracking).
- `policy.delivery.mergePolicy` (`.omp/foreman.json`, default `operator`)
  decides who invokes `gh stack merge`:
  - `operator`: it is the operator's decision on every layer; run it
    yourself only on the operator's explicit instruction.
  - `agent-on-green`: the delivering agent may merge only when CI is green,
    the QA gate returned `PASS`, and no operator comment is unresolved.
    Merge bottom-up, one layer at a time, and re-check that gate for each
    layer. Merging layer K takes every layer below it, so never merge the
    top as a shortcut.

### Conflicts during a cascade

A `gh stack rebase` conflict is resolved on behalf of a layer you may
not have written — the intent to recover is the *layer's own*, from
its subtask issue and its own PR, not the stack's overall goal.
Resolving a mid-stack conflict toward the top layer's intent silently
rewrites what the lower layer meant.

Point at `skill://resolving-merge-conflicts` for the method. The same
two rules apply here: always resolve and never `--abort` — an abort
throws away the information you just paid to recover. And never
invent behavior to make a hunk compile: recover each side's intent
from its commits and PR, and where the two are genuinely
incompatible, pick the one matching that layer's intent and say so.

## Restructuring

Adding a forgotten seam mid-track: `gh stack add` only stacks on top. To
insert or reorder layers use `gh stack modify` (interactive) — or, from
automation, `gh stack unstack --local` + `gh stack init <branches in
order>` + `gh stack submit`. Never restructure layers whose PRs the
operator has already merged or queued.

## When the track is done

All layers merged: `gh stack sync --prune` (deletes merged local
branches), confirm every subtask issue is `Done`, then report the track
worktree's state — the orchestrator retires it through
`skill://worktree`'s `remove`, and the track is not done while it exists.
The stack object dissolves with its last merge; nothing to clean up on
GitHub.
