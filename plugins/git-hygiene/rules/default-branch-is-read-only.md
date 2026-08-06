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

If you genuinely believe a mutation must happen on the default branch, stop
and say so plainly rather than proceeding — that is a decision for whoever
owns the repository, not a judgment call to make mid-task.
