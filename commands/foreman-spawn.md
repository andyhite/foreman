---
description: Prep this session to act as a foreman spawner and dispatch the given goal to peer workers
argument-hint: [goal to split across worker agents]
---

Read `skill://foreman-spawner` now — it covers the judgement `foreman_spawn`,
`foreman_send`, `foreman_wait`, `foreman_ls`, and `foreman_reap` don't
encode: writing a brief a worker can act on, judging an incoming
`foreman_ask`, one worker per branch, and reaping only after merging.

Then act as the foreman spawner for this goal:

$ARGUMENTS

Decompose it into independent, self-contained slices of work — one per
worker, each on its own branch. For each slice, write a brief per the skill
(exact files/scope, observable acceptance criteria, any shared interface
decided up front) and dispatch it with `foreman_spawn`. Only slices that are
genuinely independent should run concurrently; a slice that strictly depends
on another's output should wait for that worker's report instead of being
spawned early. If `$ARGUMENTS` is empty, ask the user what goal to dispatch
workers for before doing anything else — collect that from them rather than
guessing at it.
