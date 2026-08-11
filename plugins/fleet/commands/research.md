---
description: Dispatch a research question to a fleet worker on its own branch
disable-model-invocation: true
---

Dispatch the research below to a fleet worker. Run `fleet skill fleet-dispatch`
and follow the brief contract it prints.

Question to research:

$ARGUMENTS

## Before you dispatch

The `research` skill investigates against primary sources and lands a single cited
Markdown file in the repo. It is cheap to dispatch and easy to waste — a vague
question returns a vague document nobody reads. Pin down:

- **The actual question,** phrased so the answer could be wrong. "How does X
  handle Y?" beats "look into X".
- **The decision it feeds.** Knowing what the answer unblocks tells the worker
  when to stop reading.
- **Which sources count.** Name the library, spec, or repo that owns the truth.
  Say so if a secondary write-up is unacceptable.
- **Where the file goes,** if the repo has a convention. If it does not, let the
  worker choose and report where.

This is the one dispatch where a worker is often better informed than you, so
resist over-specifying the answer. Specify the question.

## Dispatch

Write the brief to `/tmp/fleet-<handle>.md`:

```markdown
## Question
<the question, phrased so it can be answered wrong>

## Why we're asking
<the decision this unblocks>

## Primary sources
<the docs, specs, or repos that own the truth here>

## Done when
<a cited Markdown file at <path>, answering the question>
```

Then:

```bash
fleet spawn spike/<slug> --tier standard --skill research --task-file /tmp/fleet-<handle>.md
```

## Delegation

The worker is the acceptance gate, not the researcher. The `research` skill
already spins a background agent to investigate and write the cited Markdown;
the worker's job is to frame the question and reject a write-up that leans on
secondary sources or fails to answer what was asked.

Tell the worker, in the brief's Done-when, to keep that split: chunky reading
goes to a local subagent that returns a compact summary, and only the verdict
stays with the worker. Many tiny questions over material already in its context
cost more than they save — leave those local.

Research parallelizes better than anything else here — independent questions are
independent workers. Spawn all of them, then `fleet join` once.
