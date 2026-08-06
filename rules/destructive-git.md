---
description: Destructive git commands erase uncommitted work — look at what you're deleting first
condition: 'git\s+reset\s+--hard|git\s+clean\s+-\w*[fd]|git\s+(restore|checkout)\s+(--\s+)?\.(\s|$)|git\s+branch\s+-D\b|git\s+stash\s+(drop|clear)'
scope: tool
interruptMode: tool-only
---

That command destroys uncommitted or unmerged state with no undo:

- Run `git status` and read it first. In this workflow, dirty state in your
  worktree may not be yours alone — QA's e2e additions and subagent slices
  land as uncommitted changes until you commit them.
- Prefer recoverable moves: `git stash push` over `reset --hard`/`restore .`,
  `git branch -d` (refuses unmerged) over `-D`.
- `git clean -fd` deletes untracked files — new test files and fixtures
  that were never staged are exactly what it eats.
- If the point is "get back to a known state", say which state and why in
  your next commit or report — a wipe that can't be explained shouldn't run.
