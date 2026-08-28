# Resume procedure

Two paths land here, both under the loop's `PrintDispatcher`, where every dispatch is a fresh process — the original agent's registry entry died with it, so a fresh spawn landing in resume mode is the normal continuation path, not a fallback:

- **Operator unblock.** `/foreman-unblock <ISSUE-ID>` recorded the operator's reply and cleared the `blocked:*` label. The next loop pass re-dispatches implement.
- **Review fix cycle.** A `ReviewResult` carried blocking findings. The extension wrote them to the issue and re-dispatched implement against the same worktree.

If the original agent's process happens to still be alive (interactive or herdr-dispatched session, still `idle`), a `hub` message to it is cheaper than a respawn — it already holds the context. But do not wait for that; assume you are a fresh process reconstructing context from disk and Linear.

## Detection

The extension creates the worktree before every implement spawn. If it already contains commits beyond the base branch, this is a resume.

## Continuation

1. Read the prior `BlockRecord` (if the block was Case A/B, §9) or the review findings comment (if this is a fix cycle) from the issue's Linear comments.
2. Read the operator's reply, if any — the comment left by `/foreman-unblock`.
3. Read the partial commits on the branch (`git log`, `git diff` against the base) to see what was already built.
4. Continue from there: address the findings or the operator's answer, extend the existing work, don't restart. Re-run only the tests affected by your changes plus the full suite for the acceptance criteria you're touching.
5. Proceed with the normal procedure (SKILL.md steps 3–6) from this point.

Never discard prior commits to "start clean." The worktree state is the only record of that work; the operator paid for it once already.
