---
description: Groom ideas and the backlog (accept/reject, breakdown, promotions)
argument-hint: "[issue-number] (empty = full grooming pass)"
---

Run a grooming pass. Scope, as given (an issue number to groom one item, or
empty for a full pass):

$ARGUMENTS

Read `skill://grooming` and `skill://tracker`, then run the grooming
procedure: research each idea and recommend accept-as-task / accept-as-epic
/ reject / defer — **decisions are mine, batch them into as few ask rounds
as possible** — then apply the outcomes (re-spec bodies, relabel, statuses,
epic breakdowns as sub-issues). Include the bug pass (untriaged bugs,
backlog severity promotions) and the stale-board sweep unless I scoped you
to a single issue.

Finish with a summary table: item → decision → resulting label/status,
plus anything flagged stale and what was done about it.
