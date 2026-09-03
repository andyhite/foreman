# Dedupe reference

## Duplicate

Two items describing the **same underlying defect or request**: same root
cause, same fix location, same user-visible symptom. A different symptom of
the same root cause, or a follow-on request depending on the first, is
**related**: propose `blocked by`, not `duplicateOf`.

Judge by:

- **Symptom.** Would fixing one close the other with no further work?
- **Scope.** Broad ("search is slow") does not subsume narrow ("search times
  out on queries over 200 chars"); the narrow one may survive the broad fix.
  Scope differs → `blocked by` over `duplicateOf`.
- **Component.** Same file or module = supporting evidence, not proof.

## The asymmetry

Missed duplicate: one redundant backlog issue; cheap, catchable later. Wrong
duplicate call: the merged item's acceptance detail, repro steps, and
reporter context silently absorbed into an issue that may not cover them.
Uncertain → do not call it: lower `reproConfidence`, note the candidate in
`missingInfo`, let the operator decide.

## Naming the duplicate

`duplicateOf` MUST be an issue ID the operator can open in one click,
resolved from the backlog read. No confident ID → leave `duplicateOf` null
and note the candidate in `missingInfo`.
