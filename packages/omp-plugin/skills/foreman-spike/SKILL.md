---
name: foreman-spike
description: Use when foreman-refine specifies a spike for a genuine unknown that blocks estimation.
---

# Foreman Spike

`foreman-refine` never runs a spike itself; it only specifies one
(`spikeCreated`) and lets the extension create the issue and wire the
`blocks` relation. This skill governs drafting that specification, not
investigating the question.

<critical>
- NEVER draft a spike whose question has no bounded answer; sharpen it first.
- NEVER draft a spike with no budget; an unbounded spike is unbilled wandering.
- NEVER use a spike to smuggle in implementation; the answer is a separate, newly refined issue.
</critical>

## Preconditions

A genuine unknown blocks estimation of the issue you are refining — not
"unfamiliar code," a real question no amount of reading resolves without
dedicated investigation.

## Procedure

1. **Sharpen the question** to a yes/no or bounded-answer form: not
   "investigate performance" but "does query latency exceed 200ms at 10x
   current volume?"
2. **Set the budget** (time or request ceiling): the timebox that ends the
   spike whether or not the question is answered.
3. **State the deliverable**: the artifact the spike must produce
   (benchmark result, design note, prototype diff kept out of production).
   "Could not determine X within budget; here is what we tried and what
   would resolve it" is a valid, complete deliverable — the field asks for
   the shape of the answer, not a guarantee of one.

## Output

A `spikeCreated` value (`SpikeSpec`: `title`, `question`, `budget`,
`deliverable`) on the `RefineResult`. The extension creates the spike issue
from it and wires the native `blocks` relation back to the issue being
refined; you write none of it to Linear yourself.
