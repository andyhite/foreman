# Finding severity rubric

## `blocking`

Must change before merge. The review gate treats any outstanding `blocking` finding as a fail — zero must remain for the gate to pass. Each `blocking` finding costs one of the two review→fix cycles the issue gets before it converts to `blocked:needs-decision` for the operator (§7.4). Reserve it for what actually has to change: a failed acceptance criterion, a Definition of Done violation, a correctness bug, a test that wouldn't catch the regression it claims to cover.

## `should-fix`

Should change, does not hold the merge. Real problems — weak naming, a missed edge case that's unlikely but plausible, organization that will bite the next person — that don't rise to blocking. These accumulate as review comments; they don't gate anything.

## `nit`

Preference. Style, phrasing, minor consistency. Cheapest to raise, costs nothing to ignore.

## Calibration

Two review→fix cycles without convergence means the disagreement is operator information, not something to keep negotiating. If you're reviewing a diff for the second time (resume mode, cycle 2) and your `blocking` findings are substantively the same category of thing the implementer already addressed once, consider whether the real problem is that the acceptance criteria were underspecified — that's diagnostic information for refine, not a reason to invent a third round yourself. Don't downgrade a genuine blocker to `should-fix` just to avoid triggering the decision conversion; that defeats the mechanism.
