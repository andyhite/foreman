---
description: Force pushes use --force-with-lease, never bare --force
condition: 'git\s+push[^\n]*\s(-f\b|--force(?!-with-lease))'
scope: tool
interruptMode: tool-only
---

Bare `--force` overwrites whatever the remote has — including a push you
never saw (QA's e2e commits, a steer-fix from another turn, your own push
from a retried step). After a rebase, push with `--force-with-lease`: it
fails instead of destroying history the local clone hasn't seen. Inside a
stack, prefer `gh stack push` / `gh stack sync`, which lease-check every
branch.

If the lease fails, that is information: fetch, look at what moved, and
reconcile — don't escalate to bare `--force`.
