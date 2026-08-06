---
description: the main branch is PR-only — branch protection enforces it; don't fight it locally
condition: 'git\s+push[^\n]*[\s:](main|master)\b|git\s+merge\s+(?!--abort|--continue|--ff-only)'
scope: "tool:bash"
interruptMode: tool-only
---

That command pushes at the main branch or creates a merge.

- The main branch accepts only operator-merged pull requests — branch
  protection rejects direct pushes server-side; don't try to outrun it.
- Merge commits never happen locally: take updates onto your branch with
  `git rebase origin/<mainBranch>` (or `gh stack sync` inside a stack);
  update a local main checkout only with `git pull --ff-only` or `git merge
  --ff-only origin/<mainBranch>`.
- Merging a PR is the operator's decision. Run `gh pr merge` only on the
  operator's explicit instruction in this conversation — never on your own
  judgment, however green the checks.
- The primary checkout stays on the main branch; topic branches live in
  worktrees (`skill://worktree`). Fetching, pulling, and reading it are
  normal — this rule is about writing to it.
