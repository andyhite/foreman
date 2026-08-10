# Skill Mechanics — invocation and routing in omp

Apply the writing principles in [SKILL.md](SKILL.md) to omp skills and
commands. This reference covers frontmatter, invocation choice, splitting by
invocation, and router commands.

## Frontmatter and layout

An omp skill lives at `skills/<name>/SKILL.md`. Its frontmatter contains
exactly two keys:

```yaml
---
name: writing-for-agents
description: Reference for writing any document an agent consumes. Read when creating or editing agent-facing prose.
---
```

Make `name` match the directory. Write `description` as a model-facing
context pointer: identify the material, then encode the branches that should
make an agent reach it. The pointer-writing rules in [SKILL.md](SKILL.md)
apply in full.

Omp has no `disable-model-invocation` key. A capability reached by hand is
exposed instead as `commands/<name>.md`. The command delegates to the skill
through a `skill://` reference, so the human selects the entry point while
the skill remains the single source of its instructions.

## Invocation trade

Choose between two entry points by trading the two loads:

- A **model-invoked skill** has `name` and `description` frontmatter, so an
  agent can reach it unaided and another skill can name it. Its description
  is an always-loaded context pointer: permanent context load buys automatic
  discovery. Shared reference needed by several skills belongs here because
  each can reach one source of truth.
- A **user-invoked command** fires only when the human names it. It spends no
  always-loaded description and therefore no context load, but it spends
  cognitive load: the human is the index that remembers the command and
  chooses when to run it. Keep the command thin and delegate its procedure
  through the relevant `skill://` reference.

Pick model-invocation only when the agent, or another skill, must reach the
material unaided. If it only ever fires by hand, make it a command and pay no
context load.

## Splitting by invocation

Split out a model-invoked skill when a distinct leading word should trigger
it independently, or when another skill must reach it. Every new skill adds
an always-loaded description, so the independent reach must repay that
context load.

Split out a command when the branch begins only through an explicit human
action. Give the command one memorable name and leave the detailed procedure
behind its delegated skill reference.

## Router commands

When hand-invoked commands multiply past what a human can remember, add a
**router command**. It names the available commands or skills and states
when to reach for each, giving the human one entry point instead of many.
The router delegates; it does not duplicate their procedures.

A router trades many pieces of cognitive load for one. Keep its branches
sharp enough that the human can choose a route, and leave each route's body
in its own single source of truth.
