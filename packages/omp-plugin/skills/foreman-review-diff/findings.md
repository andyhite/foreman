# Finding severity rubric

## `blocking`

MUST change before merge. Any outstanding `blocking` fails the review gate;
zero must remain. Each costs one of the review→fix cycles the `foreman
build` loop counts before it moves the issue to Needs Input with a
needs-decision block record once `loop.reviewCycleCap` is reached. Reserve
for: a failed acceptance criterion, a Definition of Done violation, a
correctness bug, a test that would not catch the regression it claims to
cover.

## `should-fix`

SHOULD change; does not hold the merge. Real problems below blocking: weak
naming, a plausible-but-unlikely missed edge case, organization that will
bite the next person. Accumulate as review comments; gate nothing.

## `nit`

Preference: style, phrasing, minor consistency. Free to raise, free to ignore.

## Calibration

Reaching the `foreman build` loop's `loop.reviewCycleCap` without
convergence = operator information, not further negotiation. Reviewing for
the second time (resume, cycle 2) with `blocking` findings in the same
category the implementer already addressed once → consider whether the
criteria were underspecified; that is diagnostic input for refine, not
grounds to invent a third round. NEVER downgrade a genuine blocker to
`should-fix` to avoid the decision conversion; that defeats the mechanism.
