---
description: Dispatch a design question to a fleet worker on a throwaway branch
disable-model-invocation: true
---

Dispatch the prototype below to a fleet worker. Read `skill://fleet-dispatch`
and follow the brief contract it prints.

Design question to answer:

$ARGUMENTS

## Before you dispatch

The `prototype` skill branches on the *kind* of question, and the two branches
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

Workers are always omp now, so the brief's body opens with the lowercase word
`orchestrate` as its first word — plain prose, not inside backticks. That word
triggers omp's magic-keyword contract: it scopes the full task, delegates
substantial independent work in parallel, verifies each phase, and continues
until the request is complete, from the worker's very first turn. Compose the
brief as text:

```markdown
## Question
orchestrate this prototype: <the design question>

## Which branch
<"logic — single shareable HTML file" or "UI — variations on one route">, because <why>

## Cases to make visible
<the states or walkthroughs that are hard to reason about on paper>

## Context
<the module or page this is prototyping for; how to run the project>

## Done when
<a runnable artifact at <path>, plus the verdict on the question>
```

Then, passing the brief as `task`:

```
fleet_spawn({ branch: "spike/<slug>", tier: "deep", skill: "prototype", task: "<the brief above>" })
```

## Delegation

Choosing the prototype branch (logic HTML vs UI variations) and judging whether
the artifact answers the design question stay with the worker. Construction of
the artifact — the HTML file, the variation routes, the floating switcher — is
mechanical and should go to a local subagent that returns the path and a short
walkthrough.

Keep the brief's "which branch" decision explicit so the worker does not spend
its judgement budget re-litigating it.

Several competing answers to the *same* question is a legitimate fan-out: spawn
one worker per approach on its own branch and compare the branches.
