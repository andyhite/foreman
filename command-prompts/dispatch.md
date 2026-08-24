---
description: Dispatch one piece of work to a fleet worker on its own branch
---

Dispatch the work below to a fleet worker. Read `skill://fleet-dispatch` and
follow the brief contract it prints, then `skill://fleet-orchestrate` for the
CLI mechanics underneath it if you have not already.

Work to dispatch:

$ARGUMENTS

## Before you dispatch

This command carries no assumption about *how* the work gets done — no
built-in skill, no fixed branch prefix, no house process. Settle, here,
whatever the worker cannot recover on its own:

- **What "done" looks like.** Checkable, not a vibe.
- **Scope.** The files or modules in play, then the explicit non-goals.
- **The process, if there is one.** A configured house convention goes in
  `role`; it resolves once through fleet's config, and there may be only one.
  Every literal procedure goes in `skills`; it may list any number of skill
  names. When both apply, use both: the role-mapped skill precedes literal
  skills in the prompt. Leave both unset for a plain task brief; the worker
  figures out its own approach.
- **A branch and a tier**, if neither is already implied. `standard` for
  dispatch-heavy work, `deep` when the worker itself has to hold judgement.

## Dispatch

Compose the brief using the shape `skill://fleet-dispatch` describes — what
this is, scope, done when — then spawn:

```
fleet_spawn({
  branch: "<branch>",
  tier: "<standard|deep>",
  role: "<optional role name>",
  skills: ["<zero or more literal skill names>"],
  task: "<the brief above>",
})
```

Once it is out, keep working. Reports and questions arrive on their own,
tagged `[fleet:<handle>]`, as the worker settles — no blocking wait required.
Call `fleet_join({})` only when there is genuinely nothing else to do.
