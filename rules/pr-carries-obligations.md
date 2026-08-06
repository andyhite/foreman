---
description: Opening a PR carries obligations — title, proof, Closes, board move, QA verdict
condition: 'gh\s+pr\s+create|gh\s+stack\s+submit'
scope: "tool:bash"
interruptMode: tool-only
---

A PR is opening — the checklist that makes it reviewable and trackable:

- **Title** is a Conventional Commit header: a squash merge takes it as the
  commit subject (≤ 72 chars, lower-case subject). `gh stack submit --auto`
  generates junk titles — `gh pr edit` each new layer, then `gh pr ready`.
- **Body** says what changed, why, and **how it was exercised** — the
  observed behavior, not "tests pass" — plus `Closes #<issue>`.
- **QA verdict** goes on the PR as a comment (who reviewed, what was
  checked, PASS).
- **Board**: the issue moves to `Review` now, not "later".
- Branch is rebased onto fresh `origin/<mainBranch>` and this repo's full
  verification command is green _after_ that rebase.

Then wait: the operator merging is the approval; an operator comment is a
change request. You never merge.
