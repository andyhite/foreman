---
description: While the checkout is on the default branch, treat the tree as read-only — branch before the first mutation, not after it
alwaysApply: true
---

**Never mutate a working tree that is sitting on the default branch.** Not a
write, not an edit, not a delete, not a rename, not a formatter run that
rewrites in place, not a codegen command that emits into the tree. Reading,
searching, and inspecting are fine — the prohibition is on mutation.

- **Establish the branch before the first mutation, not after.** Check
  `git branch --show-current` (or `git status`) before the first write of a
  session. Discovering you were on `main` after ten edits leaves you
  reconstructing which changes were yours.
- **Branch or worktree first.** Create the topic branch (or a dedicated
  worktree beside the primary checkout) and make every change there. This
  costs one command and removes an entire class of recovery work.
- **"It's a one-line fix" is not an exception.** Small changes on the default
  branch are how the branch acquires unreviewed commits. Size has never been
  the criterion.
- **Already made edits on the default branch?** Don't panic-revert — that
  destroys the work. Create a branch from where you are, which carries the
  uncommitted changes with you, and commit there.

**What backs this up, and what doesn't.** In every repo this is advisory: a
standing instruction to you, not a check that runs. No condition can ask
which branch is checked out, so nothing intercepts the first write — the
discipline above is the whole mechanism. A repo wired for foreman
(`.omp/foreman.json` at its root) adds one narrower guard underneath it:
the extension blocks git mutations that this session aims at the
configured main branch — every git command that writes, from `commit` and
`push` through `rm`, `mv`, `stash`, and `reset`. What it can't see is the
larger half of this rule: a plain write or delete, an in-place formatter
run, a codegen command emitting into the tree. Those aren't git
operations, so they reach the tree unimpeded. It also governs this
session's own tool calls and nothing else — a person working in their
own terminal on the same checkout is unaffected, as is anything that
happens before the config exists.

If you genuinely believe a mutation must happen on the default branch, stop
and say so plainly rather than proceeding — that is a decision for whoever
owns the repository, not a judgment call to make mid-task.
