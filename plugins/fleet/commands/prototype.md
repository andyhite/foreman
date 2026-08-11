---
description: Dispatch a design question to a fleet worker running skill://prototype on a throwaway branch
---

Dispatch the prototype below to a fleet worker. Follow the brief contract in
`skill://fleet-dispatch`.

Design question to answer:

$ARGUMENTS

## Before you dispatch

`skill://prototype` branches on the *kind* of question, and the two branches
produce completely different artifacts. Getting it wrong wastes the whole
prototype, so decide here rather than letting the worker guess:

- **"Does this logic or state model feel right?"** → a single shareable HTML
  file the user can drive, pushing the state machine through the hard cases.
- **"What should this look like?"** → several radically different UI variations
  on one route, switchable from a floating bar.

Then supply:

- **The question,** and what a convincing answer would look like.
- **The cases that are hard to reason about on paper** — the ones the prototype
  exists to make visible. For a logic prototype these are the walkthroughs; for
  a UI prototype they are the states the variations must each handle.
- **Who drives it.** If a non-developer needs to click through it, say so.
- **How to run the project,** if a UI prototype has to live inside it.

A throwaway branch is exactly what the skill asks for, so a fleet worker suits
this well — the prototype is captured as a primary source and main stays clean.

## Dispatch

Write the brief to `/tmp/fleet-<handle>.md`:

```markdown
Read `skill://prototype` and follow it for the question below.

## Question
<the design question>

## Which branch
<"logic — single shareable HTML file" or "UI — variations on one route">, because <why>

## Cases to make visible
<the states or walkthroughs that are hard to reason about on paper>

## Context
<the module or page this is prototyping for; how to run the project>

## Done when
<a runnable artifact at <path>, plus the verdict on the question>
```

Then:

```bash
fleet spawn spike/<slug> --task-file /tmp/fleet-<handle>.md
```

Several competing answers to the *same* question is a legitimate fan-out: spawn
one worker per approach on its own branch and compare the branches.
