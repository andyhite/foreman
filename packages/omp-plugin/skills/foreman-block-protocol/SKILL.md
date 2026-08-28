---
name: foreman-block-protocol
description: How to yield a BlockRecord instead of asking the operator a question. Bound to every agent.
---

## Preconditions

You've hit something you'd otherwise ask the operator about, or you've exhausted budget.

## Required reads

None. This skill is self-contained by design — it's loaded on every spawn.

## Procedure

No agent asks the operator a question in-session. Headless children have no approval UI; an agent that "asks" just stalls and burns budget until the runtime kills it. Yield a `BlockRecord` instead.

**Case A — blocked by another issue.** Set `type: "dependency"`, name the blocker(s) in `blockedByIssues`. Apply no label — the native relation is the state, and it resolves itself when the blocker completes.

**Case B — blocked on a human.** Set `type` to `needs-input` or `needs-decision`. Fill `whatIWasDoing`, `whatINeed` (the question or `options[]` with tradeoffs), `recommendation` if you have one, `stateLeftBehind` (worktree, branch, pushed, commits, notes), and `costOfWrongGuess`.

Budget exhaustion is Case B, `type: "budget"` — not a silent stall.

Yield through the `yield` tool with the envelope's `blocked: true` and `result: null`. A run that stops without yielding this way delivers nothing; the lock and worktree sit until the reaper notices.

## Output schema

The `BlockRecord` branch of your agent's envelope schema.

## Stop conditions

This skill *is* the stop condition. There is no further escalation past yielding a `BlockRecord`.

## Non-goals

- Never wait for a reply. There's no one listening.
- Never guess past a genuine unknown to avoid blocking. A vague `BlockRecord` usually means the issue was under-refined — write the confusion down precisely; that's diagnostic value, not failure.
