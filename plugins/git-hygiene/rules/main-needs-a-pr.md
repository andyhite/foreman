---
description: The default branch changes only through a merged pull request — no direct pushes, no local merge commits, no protection bypass
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
  `git rebase <default-branch>`; the only legitimate local merge is a
  fast-forward of your own default-branch checkout (`--ff-only`).
- **`--admin` is protection bypass.** `gh pr merge --admin` merges over failing
  or missing required checks. If the checks are wrong, fix the checks; if
  they're irrelevant to this change, say why before overriding.
- **Server-side rejection is the backstop, not the rule.** Branch protection
  refusing the push means the guard worked — it is not a signal to find a way
  around it.

If the push is failing because the branch is behind, rebase and push the
branch — not the default branch.
