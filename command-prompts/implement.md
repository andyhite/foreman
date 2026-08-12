---
description: Dispatch implementation work to a fleet worker on its own branch
---

Dispatch the implementation below to a fleet worker. Read
`skill://fleet-dispatch` and follow the brief contract it prints.

Work to implement:

$ARGUMENTS

## Before you dispatch

The `implement` skill drives the `tdd` skill at pre-agreed seams and closes with
the `code-review` skill. Both of those need decisions the worker cannot make
alone, so settle them here:

- **The spec or tickets.** A ticket reference is enough *only* if the worker can
  read it — a tracker ID it can fetch, or a spec file in the repo. Otherwise
  inline the whole thing. If neither exists yet, stop and read
  `skill://to-spec` or `skill://to-tickets` first.
- **The seams to test at.** The `tdd` skill refuses to write a test at an
  unconfirmed seam, so a worker without them will either stall on a `fleet
  reply` or guess. Name the public interfaces under test.
- **Decisions already made.** Libraries chosen, patterns to follow, existing
  code to reuse rather than reinvent. Every one you omit is one the worker
  re-litigates.
- **Non-goals.** The adjacent thing it must not touch.

Ask the user for anything missing before spawning. Read `skill://grilling`
if there is more than a question or two.

## Dispatch

Workers are always omp now, so the brief's body opens with the lowercase word
`orchestrate` as its first word — plain prose, not inside backticks. That word
triggers omp's magic-keyword contract: it scopes the full task, delegates
substantial independent work in parallel, verifies each phase, and continues
until the request is complete, from the worker's very first turn. Compose the
brief as text:

```markdown
## Spec
orchestrate this implementation: <the tickets or spec, inline or a reference the worker can read>

## Seams to test at
<the public interfaces the `tdd` skill should work against>

## Decisions already made
<libraries, patterns, existing code to reuse>

## Scope
<files and modules in play; then the explicit non-goals>

## Done when
<checkable criteria>
```

Then, passing the brief as `task`:

```
fleet_spawn({ branch: "feat/<slug>", tier: "deep", skill: "implement", task: "<the brief above>" })
```

## Delegation

The worker keeps the judgement: confirming seams, driving the red-green loop at
those seams, and accepting or rejecting the result. Chunky exploration of the
tree and bulk mechanical edits go to local subagents that return a compact
summary — that is where the spend drops, because only the summary joins the
worker's context for the rest of the session.

Do not fan the tight red-green loop out to subagents. Many small questions over
material the worker already has warm cost more than keeping them local.

One branch per independently shippable piece. If the work splits into several,
compose and spawn all of them before calling `fleet_join`.
