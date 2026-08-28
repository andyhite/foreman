# Dedupe reference

## What counts as a duplicate

Two items are duplicates when they describe the **same underlying defect or
request**, not merely a related one. Same root cause, same fix location, same
observable symptom from the user's perspective — that is a duplicate. A
different symptom of the same root cause, or a follow-on request that depends
on the first, is a **related** issue: propose a `blocked by` relation instead
of `duplicateOf`.

Judge by:

- **Symptom match.** Would fixing one issue close the other without further
  work?
- **Scope match.** A broad issue ("search is slow") does not subsume a narrow
  one ("search times out on queries over 200 chars") — the narrow one may
  survive the broad fix. Prefer `blocked by` over `duplicateOf` when scope
  differs.
- **Component match.** Same file or module is supporting evidence, not proof
  — two unrelated bugs can share a file.

## The asymmetry

A missed duplicate costs one redundant issue in the backlog — cheap, and the
operator or a later triage pass can still catch it. A wrong duplicate call
costs the information in the item that got merged away: acceptance detail,
repro steps, a reporter's context, all silently absorbed into an issue that
may not actually cover them. When uncertain, do not call it — lower
`reproConfidence`, note the candidate in `missingInfo`, and let the operator
decide.

## Naming the duplicate

`duplicateOf` must name an issue ID the operator can open and check in one
click. Never point at a vague description of "the search issue" — resolve it
to a concrete ID from the backlog read. If no confident ID exists, do not set
`duplicateOf`; downgrade to a note in `missingInfo` instead.
