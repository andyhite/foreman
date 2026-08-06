---
description: Skipping git hooks (--no-verify) is exceptional and must be justified
condition: '--no-verify\b'
scope: "tool:bash"
interruptMode: tool-only
---

If this repo has pre-commit/commit-msg hooks (branch-name checks, a
repo-wide format check, commitlint), they are the gate. Skipping them is
legitimate in exactly one shape — **the failure is provably not yours**
(e.g. another session's unformatted in-flight files tripping a repo-wide
format gate). Then:

1. Prove your own slice passes the same check directly (e.g. run the
   formatter/linter scoped to just your paths).
2. Validate the commit message yourself against whatever the repo's
   commit-msg hook enforces (`--no-verify` skips that too).
3. Say so in the commit body and in your report — a silent `--no-verify`
   reads as hiding a failure.

Never skip a hook to silence a failure your own change caused, and never
commit directly on the default branch to route around one.
