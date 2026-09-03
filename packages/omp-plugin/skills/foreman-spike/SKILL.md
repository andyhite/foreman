---
name: foreman-spike
description: Use when refine spins off a genuine unknown as a timeboxed investigation, or when running a spike issue directly — investigation only, no production code.
---

# Foreman Spike

A spike with no written deliverable is unbilled wandering. Every spike ends
with a written finding; "we cannot tell yet" is a finding and ends the spike.

<critical>
- NEVER start investigating without a budget.
- NEVER run past the budget "to be thorough." The timebox is the point.
- NEVER ship production code or implement the fix the answer suggests; that is a separate, newly refined issue.
</critical>

## Preconditions

Issue carries `type:spike`, exists because a genuine unknown blocked
estimation during refine, and carries a native `blocks` relation to that
issue.

## Required reads

- The spike issue: stated question and budget.
- The issue(s) it `blocks`: what the answer must support.
- The product `Context` doc and the project brief: constraints the
  investigation must respect.

## Procedure

1. **Sharpen the question** to a yes/no or bounded-answer form: not
   "investigate performance" but "does query latency exceed 200ms at 10x
   current volume?"
2. **Set the budget** (time or request ceiling) if the issue lacks one.
3. **Timebox to it.** Budget spent → stop, answered or not.
4. **Write `## Deliverable`**: the artifact ending the spike (benchmark
   result, design note, spike report, prototype diff kept out of
   production). "Could not determine X within budget; here is what we tried
   and what would resolve it" is a valid, complete deliverable.

## Output

A written `## Deliverable` section on the spike issue, plus any follow-up
issues the finding implies, filed as normal Backlog issues with relations
back to the spike, never folded into the original blocked issue.

## Stop conditions

Budget spent = stop; the unanswered question is the deliverable. A spike is
never production-blocked in the interrupt-protocol sense; operator input
needed to even define the question → Case B block before investigation
starts.
