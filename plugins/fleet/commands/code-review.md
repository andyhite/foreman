---
description: Dispatch a two-axis review of an existing branch to a fleet worker on its own branch
disable-model-invocation: true
---

Dispatch the review below to a fleet worker. Run `fleet skill fleet-dispatch`
and follow the brief contract it prints.

Branch to review:

$ARGUMENTS

## The mechanic that makes this work

The `code-review` skill diffs `HEAD` against a fixed point *in its own checkout*.
So a reviewer is spawned **from the branch under review**, not alongside it:

```bash
fleet spawn review/<slug> --base <branch-under-review> --skill code-review --task-file <brief>
```

`--base` branches the reviewer's worktree off the tip being reviewed, so its
`HEAD` already contains the work and `git diff <fixed-point>...HEAD` is exactly
the change set. The reviewer commits its report to `review/<slug>`, leaving the
branch under review untouched.

Confirm the branch exists and has commits before spawning — an empty diff should
fail here, not inside two parallel sub-agents in another process.

## Before you dispatch

- **The fixed point.** Usually the branch's base — `main`, `origin/HEAD`, a
  release tag. The skill asks the user for it and will stall without it.
- **The spec source.** The Spec axis compares the code against what was asked
  for. Point at the issue, ticket, or spec file. If there genuinely isn't one,
  say so explicitly so the worker skips that axis instead of hunting.
- **The standards sources,** if the repo documents any and they are not in an
  obvious place.
- **Where the report goes.** A file in the worktree, so it survives — the report
  is the deliverable and terminal output does not reach you.

## Dispatch

Write the brief to `/tmp/fleet-<handle>.md`:

```markdown
## Fixed point
<the ref to diff against — this is the "since" the skill asks for>

## What was asked for
<the issue / ticket / spec file, or "no spec — skip the Spec axis">

## Standards sources
<paths to documented standards, or "none documented">

## Done when
<both axes reported to <path> in this worktree, and committed>
```

Then spawn from the branch under review:

```bash
fleet spawn review/<slug> --base <branch-under-review> --skill code-review --task-file /tmp/fleet-<handle>.md
```

Reviewing several worker branches is a clean fan-out — one reviewer per branch,
all spawned before any `fleet join`.
