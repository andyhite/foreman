---
description: Groom ideas and the backlog (accept/reject, breakdown, promotions)
argument-hint: "[issue-number] (empty = full grooming pass)"
---

Run a grooming pass. Scope, as given (an issue number to groom one item, or
empty for a full pass):

$ARGUMENTS

Read `skill://grooming` and `skill://tracker`, then run the grooming
procedure: research each idea and recommend accept-as-task / accept-as-epic /
chart / reject / defer. Work the decisions through `skill://grilling`: ask
the whole frontier in one round with a recommended answer attached to every
question, and never ask me for a fact a `scout` can find. Apply the outcomes
(re-spec bodies, relabel, statuses, chart maps, epic breakdowns as
sub-issues). Include the bug pass (untriaged bugs, backlog severity
promotions) and the stale-board sweep unless I scoped you to one issue.

Finish with a summary table: item → decision → resulting label/status,
plus anything flagged stale and what was done about it.
