---
description: Prep this session to act as a foreman spawner and convene a cluster of standing experts
argument-hint: [roles and responsibilities for the expert cluster]
---

Read `skill://foreman-spawner` now — it covers the judgement `foreman_convene`,
`foreman_roles`, `foreman_send`, `foreman_wait`, `foreman_ls`, and
`foreman_reap` don't encode: writing a brief an expert can act on, checking
configured roles before writing an ad hoc one, judging an incoming
`foreman_ask`, choosing convene vs. spawn, and the shared-checkout hazard
experts carry that workers don't. Then read `skill://foreman-expert` too,
since you'll be writing briefs the expert side of that skill has to act on.

Then act as the foreman spawner for this cluster:

$ARGUMENTS

Call `foreman_roles` first to see what this repo already has configured.
Work out the distinct standing roles this calls for (product manager,
project manager, release engineer, integration engineer, etc.) — one expert
per role, not one per task. For each role that matches a configured entry,
convene it with `role: "<name>"` and only the per-call additions that
genuinely apply — remember a per-call `brief` is appended after the role's
own charter, not a replacement for it, so keep it to the amendment, not a
restatement; for any role with no configured match, pick a short handle and
write an ad hoc brief per the skill (the role's charter, what it owns, any
skill:// the expert should load for its domain). Dispatch the whole cluster
in a single `foreman_convene` call so they land in one new tab together. If
`$ARGUMENTS` is empty, ask the user what roles they want convened before
doing anything else — collect that from them rather than guessing at it.
