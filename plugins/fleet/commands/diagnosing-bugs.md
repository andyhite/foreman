---
description: Dispatch a bug or performance regression to a fleet worker on its own branch
disable-model-invocation: true
---

Dispatch the diagnosis below to a fleet worker. Read
`skill://fleet-dispatch` and follow the brief contract it prints.

Bug to diagnose:

$ARGUMENTS

## Before you dispatch

Phase 1 of the `diagnosing-bugs` skill is building a feedback loop that goes red
on *this* bug, and everything after it is mechanical. A worker that cannot
reproduce the symptom will burn its whole context failing to start. So the brief
lives or dies on reproduction detail:

- **The exact symptom.** The error text, the wrong value, the slow number — not
  "it breaks". Paste it.
- **How to trigger it.** The command, request, or click path. If it needs a
  running service, a seeded database, or a fixture, say how to get one.
- **How often.** Every time, or intermittently? Intermittent changes the loop.
- **The known-good point,** if there is one — a commit, version, or config where
  the symptom is absent. That turns diagnosis into a bisection.
- **Environment.** Versions, OS, flags that matter.

Ask the user for anything you cannot state precisely. A guess here is worse than
a question.

**Secrets:** the skill has the worker show commands and captured artifacts. If
reproduction needs credentials, tell it which env vars carry them and to write
`<REDACTED>` rather than the value — never paste a live credential into a brief.

## Dispatch

Compose the brief as text:

```markdown
## Symptom
<exact error text or wrong behaviour>

## Reproduction
<commands, requests, fixtures, services needed — enough to go red on demand>

## Known good
<commit / version / config where this is absent, or "unknown">

## Environment
<versions, OS, flags>

## Scope
<where the bug is suspected to live; then the explicit non-goals>

## Done when
<the regression test that now exists and passes, and the symptom is gone>
```

Then, passing the brief as `task`:

```
fleet_spawn({ branch: "fix/<slug>", tier: "deep", skill: "diagnosing-bugs", task: "<the brief above>" })
```

## Delegation

Phase 1 — building the feedback loop that goes red on *this* bug — stays with
the worker. Hypothesis ranking and the decision that the loop is faithful are
the skill's centre and do not delegate well.

Once the loop exists, chunky exploration and bulk mechanical edits go to local
subagents that return a compact summary. Leave tiny follow-ups about already-
warm context on the worker; those lose to its prompt cache.

If the symptom might have several independent causes, that is still one worker.
Diagnosis is a serial hunt; splitting it just duplicates the reproduction work.
