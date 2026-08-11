---
description: Turn a PRD, spec, or brief into a tracked backlog of epics, tasks, and charts
argument-hint: "<file path | url | issue number | pasted text>"
---

Run a PRD intake. The source document, as given:

$ARGUMENTS

If that is empty, ask for the document before doing anything. If a ledger
already exists for it under `docs.prd`, this is a **re-intake**: diff
against the recorded revision, re-derive nothing that didn't change, and
work outward by blast radius — the changed rows, then whatever shares a
contract or dependency edge with them, then the whole delivery order if a
goal or constraint moved. Tell me every issue whose wave changed.

Read `skill://prd-intake`, plus `skill://tracker` and `skill://grooming`
for the mechanics and the sizing rule (run `/foreman:init` first if
`.omp/foreman.json` doesn't exist). Then run the pipeline: capture and
number every requirement, reconcile against the code, the tracker, and the
recorded decisions with parallel `scout` dispatches, interrogate me through
`skill://grilling` with `skill://domain-modeling` alongside it, slice into
outcomes, and sequence into waves.

Do not create a single issue until I've approved the ledger. Present the
draft first: dispositions per requirement, delivery order with rationale,
derived requirements called out as your additions, out-of-scope with
reasons, and which of the four transcription tests bit.

Route fog to a chart rather than guessing a breakdown, break down wave-1
epics only, and commit wave 1 to `To Do` with everything later left at
`Backlog`.

Finish with the ledger path and a table: requirement → disposition →
issue, wave 1 in delivery order, and the derived requirements listed
separately — those are the ones I most need to check, because my document
doesn't contain them.
