---
description: merging a PR is the operator's decision, and topic branches live in worktrees — the foreman extension already blocks writes aimed at the main branch
condition: 'gh\s+pr\s+merge\b|git\s+switch\s+(?!-c\b)|git\s+checkout\s+(?!-b\b|--\s)'
scope: "tool:bash"
interruptMode: tool-only
---

That command merges a pull request, or moves a checkout onto another branch.

- **Merging is the operator's decision.** Run `gh pr merge` only on the
  operator's explicit instruction in this conversation — never on your own
  judgment, however green the checks. The exception is
  `policy.delivery.mergePolicy: agent-on-green` in `.omp/foreman.json`, which
  hands you that decision under stated conditions (green CI, QA `PASS`, no
  unresolved operator comment) and still never bypasses the PR.
- **The primary checkout stays on the main branch.** It belongs to the
  operator: never switch its branch and never edit in it. Topic branches live
  in worktrees — see `skill://worktree` for the operation that provisions one.
  Switching branches inside a worktree you own is ordinary work; switching the
  primary checkout is not yours to do.
- **Being blocked at the main branch is the guard working.** In a repo wired
  for foreman (`.omp/foreman.json` at its root) the extension refuses git
  mutations aimed at the configured `mainBranch` before they run, including
  the forms no regex can see — a bare `git push` from a main checkout, or a
  commit made while sitting on one. Don't route around it, and don't reason
  from what the remote would have done: branch protection is an optional,
  independent defence this workflow never assumes exists.
