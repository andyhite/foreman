---
description: the main branch is PR-only — foreman blocks agent git mutations aimed at it; don't route around the guard
condition: 'git\s+push[^\n]*[\s:](main|master)\b|git\s+merge\s+(?!--abort|--continue|--ff-only)'
scope: "tool:bash"
interruptMode: tool-only
---

That command pushes at the main branch or creates a merge.

- The main branch accepts only operator-merged pull requests. In a repo
  wired for foreman (`.omp/foreman.json` at its root) the extension
  enforces that directly: a git mutation aimed at the configured
  `mainBranch` is blocked before it runs, including the forms this rule's
  own condition can't see — a bare `git push` from a main checkout, or a
  commit made while sitting on one. Being stopped there is the guard
  working, not a step to route around.
- Don't reason from what the remote will do. Branch protection is an
  optional, independent defence that this workflow never assumes is
  configured — plenty of repos running it have none, so "the server would
  have rejected it anyway" is not a reason to try the push, and its absence
  is not permission.
- Merge commits never happen locally: take updates onto your branch with
  `git rebase origin/<mainBranch>` (or `gh stack sync` inside a stack);
  update a local main checkout with `git pull --ff-only`, the one update
  the guard lets through there.
- Merging a PR is the operator's decision. Run `gh pr merge` only on the
  operator's explicit instruction in this conversation — never on your own
  judgment, however green the checks.
- The primary checkout stays on the main branch; topic branches live in
  worktrees (`skill://worktree`). Fetching, pulling, and reading it are
  normal — this rule is about writing to it.
