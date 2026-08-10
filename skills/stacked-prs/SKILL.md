---
name: stacked-prs
description: Delivering a chain of dependent subtasks as GitHub stacked pull requests under the foreman workflow — gh stack mechanics, layer-per-issue conventions, fixing a mid-stack layer on a change request, operator merge semantics, and the fallback when the feature is unavailable. Read when an epic track has two or more chained subtasks.
---

# Stacked PRs — a dependency chain ships as one stack

GitHub stacked pull requests turn a chain of dependent branches into linked
PRs: each layer targets the branch below it, reviewers see one focused diff
per layer, and GitHub handles the cascading rebases and retargeting as
layers land. That maps one-to-one onto an epic **track**: a run of subtasks
where each depends on the previous one — the worker keeps building upward
instead of waiting for merges.

The operator-merge protocol composes cleanly: PRs merge **bottom-up**, so
the operator merging layer K approves layers 1…K in one gesture (merging
the top approves the whole stack), and a comment on any layer is a change
request for that layer.

## Prerequisites — check, don't assume

- `gh extension list | grep gh-stack` (install: `gh extension install
github/gh-stack`).
- The feature may be preview/subject to change on some GitHub plans: if any
  `gh stack` command fails as unavailable, fall back to the wave model —
  deliver the chain sequentially as plain PRs, each dispatched only after
  the previous one merges — and tell the operator the stack path was
  unavailable.

## Conventions

- One **track = one worker = one worktree = one stack**. The track
  worktree is named `<repo-slug>-<epic>-<track-slug>`; each layer's branch
  keeps the normal issue convention `<type>/<issue>-<slug>`.
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
- **`gh stack merge` is the operator's decision**, on every layer, always —
  run it yourself only on the operator's explicit instruction (remember a
  mid-stack merge takes every layer below it).

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
branches), confirm every subtask issue is `Done`, remove the track worktree
(`worktree` skill). The stack object dissolves with its last merge; nothing
to clean up on GitHub.
