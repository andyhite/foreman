# Coverage ledger format

One file per source document, at `<docs.prd>/<slug>.ledger.md`.

The **slug** is the document's title, lowercased, with runs of
non-alphanumeric characters collapsed to single hyphens and any leading or
trailing hyphen dropped — "Saved Searches for Acme Support Desk" becomes
`saved-searches-for-acme-support-desk`. A document with no title takes its
filename instead, minus the extension, through the same transformation.
Derive it once, record it in the header table below, and reuse that
recorded value forever: a retitled document keeps its original slug, since
a slug that tracks the title renames the ledger out from under every issue
that cites it and turns the next re-intake into a fresh intake.

The ledger answers three questions that nothing else in the tracker can:
what did this document ask for, where did each request end up, and what
changed when the document was revised.

## Shape

````markdown
# <Document title> — coverage ledger

| | |
| --- | --- |
| Slug | `<slug>` — fixed at first intake, never re-derived |
| Source | `<repo path>` or `<url>` |
| Snapshot | `<slug>.source.md` (external sources only) |
| Ingested | `<YYYY-MM-DD>` |
| Revision | `<version, date, or content hash of the source>` |

## Goals

<The document's stated goals and success metrics, in the operator's ranked
order from the interrogation round. This ranking is what stage 5 sequences
against — record it here rather than leaving it in the conversation.>

## Constraints

<Stated constraints that bind implementation: platforms, deadlines,
compliance, performance budgets, systems that must keep working. Each one
that binds a specific epic is repeated in that epic's body as a contract;
this list is the complete set.>

## Vocabulary

| Document says | Canonical term | Where |
| --- | --- | --- |
| "basket" | Cart | `CONTEXT.md` |
| "saved payment" | Stored Payment Method | new, added this intake |

<Every term the document names differently from the codebase, resolved
during the interrogation round. The term itself lives in `docs.context`;
this table is the mapping, so a reader searching the document's word still
lands on the right work. Omit the section when the document already speaks
the project's language.>

## Requirements

| ID | Requirement | Origin | Reconciliation | Disposition | Issue |
| --- | --- | --- | --- | --- | --- |
| R1 | A shopper can resume an abandoned checkout | stated | cart state exists, no expiry | Epic | [Resume an abandoned checkout](#12) |
| R2 | Abandoned carts expire after 30 days | stated | no expiry anywhere | Task | [Expire abandoned carts after 30 days](#13) |
| R3 | Checkout supports Apple Pay | stated | already live since #88 | Covered | #88 |
| R4 | Recommendations on the cart page | stated | no recommender exists | Chart | [Cart recommendations](#14) |
| R5 | Multi-currency pricing | stated | conflicts with ADR 0004 | Out of scope | `.out-of-scope/multi-currency.md` |
| D1 | A resumed checkout re-prices against current stock | derived | silence test — stock can move | Task | [Re-price a resumed checkout](#15) |
| D2 | Cart expiry is observable in metrics | derived | silence test — no telemetry | Deferred | needs the metrics pipeline |

**Origin** is `stated` when the document says it and `derived` when intake
surfaced it. Keeping them distinguishable is the point: the derived rows are
what the operator did not write and most needs to check.

**Reconciliation** is stage 2's finding in a few words — what exists, what
partially exists, what it conflicts with.

**Disposition** is exactly one of `Task`, `Epic`, `Chart`, `Covered`,
`Out of scope`, `Deferred`, `Withdrawn`. Every row has one; a blank
disposition means intake is not finished.

**Issue** links the issue by name, or names the evidence for a `Covered`
row, the record for an `Out of scope` row, or the unblocking condition for
a `Deferred` one.

## Delivery order

**Wave 1 — committed (`To Do`)**

1. [Resume an abandoned checkout](#12) — walking skeleton: the only path
   that runs cart → pricing → payment end to end.
2. [Expire abandoned carts after 30 days](#13) — R1 is meaningless without
   a defined lifetime, and this is where the storage shape gets decided.

**Wave 2 — captured (`Backlog`)**

3. [Re-price a resumed checkout](#15) — blocked by #12.
4. [Cart recommendations](#14) — charted; breaks down once its frontier
   empties.

Each wave carries one sentence of rationale per entry, naming which
sequencing rule put it there: learning, walking skeleton, dependency, value
density, or reversibility.

## Open questions

<Anything the interrogation round could not settle, with what would settle
it. Empty is the normal end state; a non-empty list is a promise to come
back.>

## Revisions

| Date | Revision | Change |
| --- | --- | --- |
| 2026-02-14 | v1 | Initial intake — 5 stated, 2 derived. |
| 2026-04-02 | v2 | R5 withdrawn by author (#19 closed). R6–R7 new, wave 3. D1 reworded, no issue change. Goals reranked: #13 moved wave 1 → wave 2 (`To Do` → `Backlog`), #14 wave 2 → wave 1 and broken down. |
````

## Rules

- **IDs are permanent.** Never renumber, never reuse. A withdrawn
  requirement keeps its row so a future reader can tell "we decided against
  it" from "nobody thought of it".
- **One outcome per row.** If a row needs the word "and", it is two rows.
- **The ledger is generated and owned by foreman; the source document is
  not.** Edits belong here, never in the source.
- **Fill issue links at land time**, not at proposal time — the draft
  presented for approval has dispositions but no numbers yet.
- **A revision entry names every issue that moved**, not just the rows that
  changed. Re-intake re-validates the connected outcomes and the whole
  delivery order when goals or constraints move, so an issue can change
  wave and status without its own requirement being touched — and an
  unrecorded move is indistinguishable from someone editing the board by
  hand.
