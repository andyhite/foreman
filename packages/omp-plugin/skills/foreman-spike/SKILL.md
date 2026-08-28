---
name: foreman-spike
description: Use when refine spins off a genuine unknown as a timeboxed investigation, or when running a spike issue directly — investigation only, no production code.
---

# Foreman Spike

A spike with no written deliverable is unbilled wandering. Every spike ends
with a written finding, even when the finding is "we cannot tell yet" — that
is still a finding, and it still ends the spike.

## Preconditions

The issue carries `type:spike`. It exists because a genuine unknown blocked
estimation of another issue during refine (§7.2 step 7), and carries a native
`blocks` relation to that issue.

## Required reads

- The spike issue: its stated question and stated budget.
- The issue(s) it `blocks`, for context on what the answer needs to support.
- The project `Context` doc, for constraints the investigation must respect.

## Procedure

1. **State the question as something answerable.** If the question in the
   issue is vague ("investigate performance"), sharpen it to a yes/no or a
   bounded-answer form ("does query latency exceed 200ms at 10x current
   volume?") before starting work.
2. **Set the budget before starting**, if not already stated on the issue —
   a time or request ceiling. Do not start investigating without one.
3. **Timebox to it.** Stop investigating when the budget is spent, whether or
   not the question feels fully answered.
4. **Write the `## Deliverable`** naming the artifact that ends the spike: a
   benchmark result, a design note, a spike report, a prototype diff kept
   out of production code. "We could not determine X within budget, here is
   what we tried and what would resolve it" is a valid, complete deliverable.

## Output

A written `## Deliverable` section on the spike issue, plus any follow-up
issues the finding implies (filed as normal Backlog issues with relations
back to the spike, not silently folded into the original blocked issue).

## Stop conditions

Running past the stated budget without a block is a stop condition on its
own: if the question isn't answered when the budget is spent, that is the
deliverable — write it up and stop. A spike is never itself production-blocked
in the interrupt-protocol sense; if it needs operator input to even define the
question, that's a Case B block before investigation starts.

## Non-goals

- Shipping production code. A spike produces findings, not a merged change.
- Expanding into implementing the fix the spike's answer suggests — that is
  a separate, newly-refined issue.
- Running past the budget "to be thorough." The timebox is the point.
