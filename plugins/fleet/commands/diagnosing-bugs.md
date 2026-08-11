---
description: Dispatch a bug or performance regression to a fleet worker running skill://diagnosing-bugs on its own branch
---

Dispatch the diagnosis below to a fleet worker. Follow the brief contract in
`skill://fleet-dispatch`.

Bug to diagnose:

$ARGUMENTS

## Before you dispatch

Phase 1 of `skill://diagnosing-bugs` is building a feedback loop that goes red
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

Write the brief to `/tmp/fleet-<handle>.md`:

```markdown
Read `skill://diagnosing-bugs` and follow it for the bug below.

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

Then:

```bash
fleet spawn fix/<slug> --task-file /tmp/fleet-<handle>.md
```

If the symptom might have several independent causes, that is still one worker.
Diagnosis is a serial hunt; splitting it just duplicates the reproduction work.
