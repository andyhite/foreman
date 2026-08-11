---
description: Dispatch implementation work to a fleet worker running skill://implement on its own branch
---

Dispatch the implementation below to a fleet worker. Follow the brief contract
in `skill://fleet-dispatch`.

Work to implement:

$ARGUMENTS

## Before you dispatch

`skill://implement` drives `skill://tdd` at pre-agreed seams and closes with
`skill://code-review`. Both of those need decisions the worker cannot make
alone, so settle them here:

- **The spec or tickets.** A ticket reference is enough *only* if the worker can
  read it — a tracker ID it can fetch, or a spec file in the repo. Otherwise
  inline the whole thing. If neither exists yet, stop and build one with
  `skill://to-spec` or `skill://to-tickets` first.
- **The seams to test at.** `skill://tdd` refuses to write a test at an
  unconfirmed seam, so a worker without them will either stall on a `fleet
  reply` or guess. Name the public interfaces under test.
- **Decisions already made.** Libraries chosen, patterns to follow, existing
  code to reuse rather than reinvent. Every one you omit is one the worker
  re-litigates.
- **Non-goals.** The adjacent thing it must not touch.

Ask the user for anything missing before spawning. Use `skill://grilling` if
there is more than a question or two.

## Dispatch

Write the brief to `/tmp/fleet-<handle>.md`:

```markdown
Read `skill://implement` and follow it for the work below.

## Spec
<the tickets or spec, inline or a reference the worker can read>

## Seams to test at
<the public interfaces skill://tdd should work against>

## Decisions already made
<libraries, patterns, existing code to reuse>

## Scope
<files and modules in play; then the explicit non-goals>

## Done when
<checkable criteria>
```

Then:

```bash
fleet spawn feat/<slug> --task-file /tmp/fleet-<handle>.md
```

One branch per independently shippable piece. If the work splits into several,
write and spawn all of them before running `fleet join`.
