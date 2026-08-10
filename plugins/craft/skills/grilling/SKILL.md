---
name: grilling
description: Interview the operator in rounds until a plan, design, or decision is settled — a design tree worked frontier-first, every question carrying a recommended answer. Read when stress-testing a plan, sizing ambiguous work, or when a decision needs the operator and guessing would be worse.
---

# Grilling — settling a decision with the operator, frontier by frontier

Interview the operator relentlessly until you reach a shared
understanding. Map the decision as a **design tree**: every choice
branches into the choices that hang off it — pick approach A and a
new set of questions opens up about A; pick B and a different set
does.

## Work the tree in rounds

The **frontier** is every decision whose prerequisites are already
settled — the questions you can ask *now* without guessing at answers
you haven't heard yet. Ask the whole frontier in one round, then
wait. Never ask ahead of the frontier, and never trickle questions in
one at a time when the round could carry several.

Use this fixed format so the operator can answer by number and weigh
your judgment with each choice:

```
**Q1 — <question title>**

<question body — may run several paragraphs, and states the actual
choices on the table>

**Recommended:** <your recommended answer>
```

When a round's questions are genuinely multiple-choice, batch them
into a single `ask` tool call instead of prose — one round-trip for
the whole round. Keep the number, title, and recommended answer on
each entry. Fall back to prose questions, in the format above, the
moment a question needs a free-form answer or more nuance than a
choice list carries; forcing a choice would hide part of the decision.

Each round's answers reshape the tree: settled decisions push the
frontier outward and unblock whatever depended on them. Recompute the
frontier before the next round. A question whose answer depends on
another question still open in *this* round belongs to a later round
— asking it now is asking the operator to guess at their own future
answer.

## Facts are yours to find, never theirs to supply

Finding facts is the agent's job, never the operator's. When a
frontier question needs something the environment already knows —
what a file contains, what a dependency does, how existing code
behaves — dispatch a `scout` subagent to find it. Never ask the
operator something you could look up yourself; that isn't
stress-testing their thinking, it's outsourcing your research to
them. Don't block the round on it either: a running scout is itself
an unsettled prerequisite, so only the questions downstream of its
answer wait — ask the rest of the frontier now.

The *decisions* are the operator's. Put each to them and wait; never
act on an answer before it's given.

## Done

The session ends when the frontier is empty — every branch of the
design tree visited, nothing left silently assumed. Do not act on the
outcome until the operator confirms you've reached a shared
understanding.

When what's being settled is *terminology* rather than *design* — the
tree keeps branching into "what do we call this" instead of "which
approach" — run `skill://domain-modeling` alongside this one:
grilling drives the interview, domain-modeling is where the answers
get written down.