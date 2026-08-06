---
description: A unit of tracked work just landed on GitHub — sync the todo list now, in this same turn, not later
condition: 'gh\s+pr\s+merge|gh\s+issue\s+close|git\s+worktree\s+remove'
scope: "tool:bash"
interruptMode: tool-only
---

That state change just happened for real — a PR merged, an issue closed,
or a worktree got cleaned up. Before doing anything else:

- If a `dev-loop` or `epic-loop` todo list is tracking this work, this is
  exactly the moment its matching item flips to `done`. Do it now, in this
  turn — not "I'll batch the todo updates at the end." The failure this
  guards against: a whole epic's worth of categorized track todos get
  created up front and never touched again, so the epic finishes with
  every todo still open despite the work actually having shipped.
- Running an epic? Check whether this landing unblocks the next track or
  dependency-gated dispatch, and whether every subtask is now `Done` —
  if so, it's time for the closeout todo audit (`epic-loop` step 6): every
  todo `done` or explicitly `drop`ped before reporting the epic shipped.
- No todo list is actually tracking this work (a one-off outside the
  dev/epic loop)? This doesn't apply — carry on.
