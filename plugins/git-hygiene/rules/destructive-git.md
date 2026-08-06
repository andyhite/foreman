---
description: Destructive git commands erase uncommitted work — look at what you're deleting first
condition: 'git\s+reset\s+--hard|git\s+clean\s+-\w*[fd]|git\s+(restore|checkout)\s+(--\s+)?\.(\s|$)|git\s+branch\s+-D\b|git\s+stash\s+(drop|clear)'
scope: "tool:bash"
interruptMode: tool-only
---

That command destroys uncommitted or unmerged state with no undo:

- Run `git status` and read it first. Dirty state in a working tree is not
  necessarily yours: a parallel agent, another session, or the user's own
  in-flight edits land as uncommitted changes until someone commits them.
- Prefer recoverable moves: `git stash push` over `reset --hard`/`restore .`,
  `git branch -d` (refuses unmerged) over `-D`.
- `git clean -fd` deletes untracked files — new test files and fixtures
  that were never staged are exactly what it eats.
- `git checkout -- <path>` restores from the **index**, not from your last
  read of the file — on a staged-then-edited file it silently throws away
  the edit. Check `git diff` (worktree vs index) before assuming it's a
  no-op undo.
- If the point is "get back to a known state", say which state and why in
  your next commit or report — a wipe that can't be explained shouldn't run.
