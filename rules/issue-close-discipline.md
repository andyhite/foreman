---
description: An issue closes exactly two ways — delivered via merged PR, or declined at grooming with a recorded reason
condition: 'gh\s+issue\s+close'
scope: "tool:bash"
interruptMode: tool-only
---

Closing an issue by hand is almost always wrong — check which of the two
legitimate paths this is:

- **Delivered**: the PR (with `Closes #N`) was merged by the operator —
  the close happens automatically; you only move the board to `Done` after
  cleanup. If you're closing manually because the auto-close didn't fire,
  fine — but the merge must exist.
- **Declined**: a grooming decision — `--reason "not planned"`, the
  rationale as a comment, board status `Rejected`. Rejection is a
  recorded, findable decision.

A **bug** needs evidence to close on either path: the reproduction no
longer triggers, and the issue says where that was shown. Never close an
issue to tidy the board, deduplicate without linking, or make a report
look better.
