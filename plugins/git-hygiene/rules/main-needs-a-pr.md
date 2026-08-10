---
description: The default branch changes only through a merged pull request — no direct pushes, no local merge commits, no merging over the checks
condition: 'git\s+push\b[^\n]*\b(main|master)(\s|$)|git\s+merge\s+(?!--abort|--continue|--quit|--ff-only)|gh\s+pr\s+merge[^\n]*--admin\b'
scope: "tool:bash"
interruptMode: tool-only
---

That command writes to the default branch, or merges outside a pull request:

- **Direct pushes don't happen.** Every change reaches the default branch as a
  reviewed pull request, however small — a typo fix and a refactor take the
  same path. Push your branch and open a PR instead.
- **Merges don't happen locally.** A local `git merge` creates a merge commit
  that was never reviewed and never ran CI. Take updates onto your branch with
  `git rebase <default-branch>`, and update your own default-branch
  checkout with `git pull --ff-only`. A `git merge --ff-only` creates no
  merge commit and is harmless in itself, but reach for the pull anyway: a
  repo running the foreman extension refuses every merge on the default
  branch, `--ff-only` included.
- **`--admin` merges over the checks.** `gh pr merge --admin` lands the PR
  regardless of failing or missing required checks, overriding whatever
  this repo does enforce. If the checks are wrong, fix the checks; if
  they're irrelevant to this change, say why before overriding.
- **Nothing here promises the server will stop you.** This rule is an
  interrupt on your own tool call, not a check running anywhere else.
  Branch protection may or may not be configured on this remote — it's an
  optional, independent defence, so neither its rejection nor its silence
  decides whether the push was allowed. A repo that also runs the foreman
  extension has one more layer: with `.omp/foreman.json` at its root, git
  mutations aimed at the configured main branch are blocked outright. Where
  none of that is in place, this rule is the only thing between you and an
  unreviewed commit on the default branch.

If the push is failing because the branch is behind, rebase and push the
branch — not the default branch.
