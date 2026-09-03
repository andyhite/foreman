---
name: foreman-block-protocol
description: How to yield a BlockRecord instead of asking the operator a question. Bound to every agent.
---

<critical>
- NEVER ask the operator in-session. Headless children have no approval UI;
  asking stalls until the runtime kills the run.
- NEVER wait for a reply. Nobody is listening.
- NEVER guess past a genuine unknown to avoid blocking.
</critical>

## Preconditions

You hit something you would otherwise ask the operator about, or exhausted
budget.

## Required reads

None; self-contained, loaded on every spawn.

## Procedure

**Case A, blocked by another issue.** `type: "dependency"`; name the
blocker(s) in `blockedByIssues`. No label: the native relation is the state
and resolves itself when the blocker completes.

**Case B, blocked on a human.** `type`: `needs-input` | `needs-decision`.
Fill `whatIWasDoing`, `whatINeed` (the question, or `options[]` with
tradeoffs), `recommendation` when you have a lean, `stateLeftBehind`
(worktree, branch, pushed, commits, notes), `costOfWrongGuess`.

Budget exhaustion = Case B, `type: "budget"`; never a silent stall.

Yield through the `yield` tool with the envelope's `blocked: true`,
`result: null`. A run that stops any other way delivers nothing; lock and
worktree sit until `foreman reconcile` notices.

## Output schema

The `BlockRecord` branch of your agent's envelope schema.

## Stop conditions

This skill is the stop condition. No escalation past a `BlockRecord`.

A vague `BlockRecord` usually means the issue was under-refined: write the
confusion down precisely. That is diagnostic value, not failure.
