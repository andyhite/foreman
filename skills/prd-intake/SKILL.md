---
name: prd-intake
description: Turning a PRD, spec, RFC, brief, or design doc into a tracked backlog of epics, tasks, and charts — requirement extraction, reconciliation against code and prior decisions, operator interrogation, outcome slicing, delivery ordering, and a coverage ledger that survives the document being revised. Read when handed a product document and asked for a backlog, or when re-ingesting a revised one.
---

# PRD intake — a document becomes a backlog, not a transcript

A product document is a **statement of intent written by someone who was
not reading the code**. It is optimistic, partial, and organised for
persuasion rather than delivery. Intake is the pass that turns it into
tracked work: every requirement reconciled against what already exists,
every silence interrogated, every outcome sliced along a seam somebody can
actually ship, and every line of the source accounted for in a ledger that
outlives the document's next revision.

Read `skill://tracker` before touching any issue, label, dependency, or
board status, and `skill://grooming` for the sizing rule and the task/epic
body shapes — intake creates issues in exactly those shapes and is bound by
exactly that sizing rule. Read every constant from `.omp/foreman.json`.

## Transcription is the failure mode

The cheap version of this job reads the headings, makes an epic out of
each, and calls the section bullets subtasks. It produces a backlog that
looks complete and is worthless: it inherits the document's structure
instead of the product's seams, commits to work nobody has costed, and
silently drops everything the document forgot to mention.

Four tests catch it. Apply each before proposing anything, and say in the
report which ones bit:

- **Heading test.** Line the epics up against the document's headings. A
  one-to-one correspondence means the slicing is transcription. Real
  outcomes cut across sections, because a heading is a topic and an epic is
  a deliverable.
- **Verb test.** Every title names an observable change in behaviour —
  "a shopper can resume an abandoned checkout", not "checkout service" or
  "phase 2". A title that names a component or a document section is a
  container someone will fill with whatever they feel like.
- **Silence test.** The document describes the happy path. Walk these
  categories against every outcome, because each is normally absent and
  each is work: error and empty states, existing data that must migrate,
  permissions and ownership, observability, rollout and flagging, what
  happens to users mid-flight, and what the feature does when a dependency
  is down. Surface what they turn up as **derived** requirements, so the
  operator sees what intake added rather than finding it in a PR.

  A derived finding earns its own row only when it is **work somebody would
  otherwise not do** — a separate decision, a separate seam, or a separate
  unit of delivery. When it is simply how you would know the outcome is
  finished, it is an acceptance criterion on the outcome that owns it, and
  it belongs in that issue's body rather than in the ledger. "Deleting a
  saved view can fail and the agent is told" is a criterion; "an agent's
  saved views are private to them" is a row, because ownership is a
  decision with its own shape. Getting this wrong in the generous direction
  buries the four or five derived rows that matter under thirty that don't.
- **Contradiction test.** Where the document disagrees with the code, with
  an ADR under `docs.adr`, with the glossary at `docs.context`, or with
  itself, that is a question for the operator. Never resolve it by picking
  the reading that makes the backlog tidier.

## The ledger is the deliverable

Issues are the output; the **coverage ledger** is the artifact that makes
the output trustworthy and re-runnable. One file per source document,
written to `<docs.prd>/<slug>.ledger.md`. It maps every requirement to
exactly one disposition, records the delivery order, and gives the next
revision something to diff against instead of re-deriving the whole backlog
from scratch. Format and worked example:
[LEDGER-FORMAT.md](./LEDGER-FORMAT.md).

Resolve `<docs.prd>` from `.omp/foreman.json` before writing anything. A
freshly bootstrapped repo has it `null`, which records that no document has
been ingested yet — bootstrap detects that directory, it never creates one
— and not that intake has nowhere to write. So on the first intake:
adopt `docs/prd/` (or a directory the operator names instead), create it,
and **write the resolved path back to `docs.prd` in `.omp/foreman.json`**,
committed alongside the ledger. A null left in place is a config that
disagrees with the tree from the moment the first ledger lands, and the
next intake, `skill://grooming`, and `skill://doctor` all read the config
rather than guessing the convention a second time.

The ledger is foreman's file. **Never edit the source document** — it
belongs to whoever wrote it, and an intake that rewrites its input destroys
the thing it is supposed to be traceable to.

## 1. Capture

Accept the document however it arrives: a path in the repo, a URL, an issue
number, or text pasted into the invocation. Read it whole before extracting
anything — a requirement's meaning routinely depends on a constraint stated
six sections later.

If the source is not already a tracked file in this repo, write a verbatim
snapshot to `<docs.prd>/<slug>.source.md` with its origin and retrieval date
at the top. External documents get edited out from under you; without a
snapshot, the next intake can tell you the document changed but not how.

Then extract **requirements**, one per row, each a single outcome someone
could check. Split compound statements ("users can export and schedule
reports" is two). Assign IDs — `R1…Rn` for stated requirements in document
order, `D1…Dn` for derived ones as the silence test surfaces them. IDs are
permanent: a requirement the next revision drops keeps its row and its
number.

Non-requirements matter too and get captured separately: goals and success
metrics (they decide priority), explicit non-goals (they become out-of-scope
records), and stated constraints (they become epic-level contracts).

*Done when* every sentence of the source has been read and every statement
of intent in it is either a numbered row or consciously classified as goal,
non-goal, constraint, or narrative.

## 2. Reconcile

The document does not know what exists. Find out before asking the operator
anything, because a question the environment can answer is a research gap,
not a decision.

Dispatch `scout` subagents in parallel — this is the stage that most
rewards fan-out, and the clusters are independent:

- **Code reality**, one scout per requirement cluster: what already exists,
  what partially exists, what the document assumes is there and is not.
  Partial existence is the expensive discovery — it turns a "build" into a
  "finish and migrate", which is a different shape of work.
- **Tracker overlap**: existing open issues covering the same ground, and
  closed-as-rejected ones covering it too. A rejected idea returning inside
  a PRD is still the same rejected idea and needs the same conversation, not
  a fresh issue.
- **Prior decisions**: ADRs under `docs.adr`, the glossary at
  `docs.context` (or the contexts reached through `docs.contextMap`), and
  concept records under `docs.outOfScope`. A requirement that violates a
  recorded decision is an amendment to that decision — surface it as one.
- **External facts**: where the document asserts something about a
  third-party API, library, or platform limit that its feasibility depends
  on, verify it with `skill://research` rather than believing it.

*Done when* every requirement row carries a reconciliation note: already
covered, partially covered (with what is missing), clear, or in conflict
(with what it conflicts against).

## 3. Interrogate

Run `skill://grilling`: work the whole frontier in one round, every question
carrying a recommended answer, and never ask the operator something a scout
could have found in stage 2. Run `skill://domain-modeling` alongside it —
product documents arrive with marketing vocabulary, and a backlog written in
words the codebase does not use is a backlog nobody can trace. Settle terms
into `docs.context` as they resolve, and write an ADR under `docs.adr` when
a decision made here is hard to reverse and surprising without context.
Record every renaming in the ledger's vocabulary table too: the document's
readers will search for the document's word, and the mapping from it to the
canonical term is what keeps the backlog traceable to the thing it came
from.

What must be settled before slicing:

- Every conflict and contradiction from stage 2.
- Every derived requirement: is it in scope, out of scope, or deferred?
- The **goal ordering**. When the document's success metrics compete, the
  operator's ranking decides delivery order. Guessing here silently
  reorders the whole backlog.
- The line between **settled** and **fog**. A requirement whose outcome is
  clear but whose route is not does not get a guessed breakdown — it gets a
  chart (stage 4). The test is charting's: can the question be stated
  precisely now?

Where a decision cannot be settled in conversation because it needs an
artifact to react to, that is a `prototype` chart ticket, not a longer
argument.

Intake does not run past this stage unattended. When the operator leaves a
question open, the rows behind it are `Deferred` carrying that question —
never `Out of scope`, because ruling a concept out is a decision somebody
has to actually make, and a provisional rejection written into
`docs.outOfScope` is a decision nobody made that every future grooming pass
will honour.

*Done when* the frontier is empty and the operator has confirmed the
reading — no requirement is carrying a silent assumption into stage 4.

## 4. Slice

Group requirements into **outcomes**: the smallest change of behaviour a
user or operator would notice and could be given on its own. Outcomes are
the unit; the document's structure is not evidence about them.

Route each outcome:

- **Task** when it satisfies grooming's sizing rule — one small PR, roughly
  a day, independently testable.
- **Epic** when it is bigger or arguable. Arguable means epic.
- **Chart** when the route is fogged: create it per `skill://charting` with
  the `labels.chart` modifier, and let it graduate into an epic once its
  frontier empties. A charted region of the PRD is the honest outcome for
  fog; an epic full of invented subtasks is not.
- **Covered** when stage 2 found it already delivered. Record the evidence
  in the ledger; do not create an issue to re-confirm existing behaviour.
- **Out of scope** when the operator ruled it out. Write the concept to
  `docs.outOfScope` when the rejection is about the idea rather than this
  document's phrasing of it — the same request returns next quarter under a
  different name.
- **Deferred** with the condition that would revive it.

Then find the **walking skeleton**: one thin outcome that runs end to end
through every layer the document touches, however trivially. It is the
first thing built, it proves the integration nobody has tested, and it is
what every later slice attaches to. A backlog whose first wave is three
parallel components and no working path is a backlog that discovers its
integration problems last.

Name each epic's **cross-task contracts** — interfaces, schemas, ownership
— in its body. `skill://epic-loop` dispatches from those; unnamed, they get
negotiated by whichever subagent gets there first. Use
`skill://codebase-design` when placing a seam is genuinely arguable, and
name the **test seam** per grooming's task shape, because `skill://tdd`
refuses an unconfirmed seam and the implementer will otherwise invent one.

Run the four tests from the top of this skill against the slicing before
moving on.

*Done when* every requirement row has exactly one disposition, the walking
skeleton is identified, and the four tests pass or their failures are
explicitly justified.

## 5. Sequence

Ordering is a judgement, not a topological sort. Rank by, in order:

1. **Learning.** Whatever, if it fails, invalidates the plan goes first.
   Unproven feasibility is the most expensive thing to discover late.
2. **The walking skeleton.** The integration proof precedes breadth.
3. **Dependencies.** The graph removes options; it does not create
   priority. Record every edge as a native issue dependency
   (`skill://tracker`) so `skill://epic-loop` can partition tracks by
   querying instead of re-reading prose.
4. **Value density.** Among what remains, the outcome users feel soonest
   per unit of work.
5. **Reversibility.** Pull a hard-to-reverse choice earlier, but never
   ahead of the learning that informs it.

Partition the result into **waves**. Wave 1 is what the team is committing
to now, and it is sized to finish before the document's next revision —
that is the constraint that keeps the backlog from rotting. Later waves are
captured but not committed.

Commitment is expressed as board status, not as a priority field:

- Wave 1 epics and tasks → `todo`.
- Every later wave → `backlog`.
- **Break down only wave-1 epics.** A wave-3 epic broken down today is
  fifteen issues written against assumptions that will have changed by the
  time anyone reads them. It stays an epic at `backlog`, and
  `skill://grooming` breaks it down when it is near — which is exactly what
  grooming is for.

*Done when* waves are assigned, dependency edges are listed, and every
delivery-order entry carries one sentence naming the rule that placed it.

## 6. Propose

**Create nothing until the operator approves the ledger.** Intake produces
tens of issues in one pass, and an unreviewed pass is tens of issues to
unpick. Present the draft ledger — the requirement table with dispositions,
the vocabulary table, the delivery order, the derived requirements called
out as additions, the out-of-scope list with reasons, and anything the four
tests flagged.

Present the drafted **body of every wave-1 issue** alongside it. Those are
the only ones being committed, and their bodies are where the acceptance
criteria, the cross-task contracts, and the test seam live — the parts of
stage 4 the ledger's one-line dispositions cannot show. Later waves are
reviewed as ledger rows only; drafting bodies for work that grooming will
re-derive is the same staleness this skill avoids everywhere else.

Take edits and re-run the affected stages. A disposition change that moves
a requirement between waves changes the ordering; re-derive it rather than
patching the table.

*Done when* the operator has approved the ledger as the plan of record.

## 7. Land

Apply the approved ledger through `skill://tracker`, in this order, because
each step needs identities the previous one creates:

1. Create every epic and task with its type label, in the grooming body
   shape, each body carrying a `Source: <ledger path> — R7, R8, D2` line so
   an issue can be traced back without the ledger being searched by hand.
2. Create chart maps and their decision tickets per `skill://charting`.
3. Link subtasks as sub-issues of their epics.
4. Add every issue to the board and set its wave's status.
5. Wire dependency edges in a second pass.
6. Write concept records under `docs.outOfScope` for rejected concepts.
7. Write the ledger to `<docs.prd>/<slug>.ledger.md` with the real issue
   numbers filled in, and commit it with the snapshot — plus the
   `.omp/foreman.json` change when this intake was the one that resolved
   `docs.prd`.

Then report: the ledger path, counts by disposition, wave 1 in delivery
order with its issue links, what was found already covered, what was ruled
out and why, what got charted rather than broken down, which of the four
tests bit and what changed as a result, and every derived requirement
listed explicitly — that last one is what the operator most needs to check,
because it is the part of the backlog their document does not contain.

## Re-intake: the document changed

Product documents get revised, and the second pass must diff rather than
duplicate. Given a source that already has a ledger:

1. Diff the new source against the snapshot (or against the tracked file's
   git history when the source lives in the repo).
2. Classify every requirement: **unchanged**, **reworded** (same outcome,
   new text — update the row, touch no issue), **changed** (different
   outcome — the row's issue needs re-speccing, or replacing if work has
   already landed against it), **new** (a fresh ID, run stages 2–7 on it
   alone), **withdrawn** (mark the row; close its open issues as not
   planned with the revision as the reason, and raise it with the operator
   if work is already in flight).
3. Never renumber and never rewrite history: append a revision entry to the
   ledger recording what moved.

What re-runs is decided by **blast radius**, not by which rows changed.
Extraction and the diff stay incremental — unchanged rows are never
re-derived and their issues are never recreated — but a change propagates
past its own row, and three radii need checking in order:

- **Local.** Re-reconcile and re-slice the changed and new rows. Their
  outcomes may split, merge, or change disposition.
- **Connected.** Any outcome sharing a contract, a dependency edge, a test
  seam, or a `Covered` evidence link with something that changed gets its
  slicing and its edges re-validated. A withdrawn requirement orphans the
  edges pointing at it; a changed one can invalidate a sibling epic's
  acceptance criteria without touching that sibling's text.
- **Global.** If the goal ranking or any constraint changed, re-derive the
  whole delivery order. Stage 5 sequences against the goals, so a reranked
  goal reorders waves that no requirement edit touched.

Re-validation is not re-creation. When it moves an issue between waves,
change its status and say so; when it pulls an epic into wave 1, break it
down now; when it pushes an already-broken-down epic out, leave the
subtasks alone and move them with their parent. Record every such move in
the revision entry — an issue whose wave changed silently is the same
confidently-wrong state a lagging ledger creates.

## Hazards

- **A one-shot intake with no operator gate is a mess to unpick.** Stage 6
  is not optional ceremony; it is the difference between fifty issues and
  fifty issues to delete.
- **Wave-1-only breakdown is deliberate.** Breaking down the whole backlog
  feels more complete and produces more stale issues.
- **A requirement marked covered needs evidence in the ledger** — a file, a
  test, a merged PR. "Looks like it exists" is how a gap ships.
- **Document ordering is not priority.** A PRD's section order reflects how
  its author explained the product, and nothing else.
- **Charted fog is a real result.** A chart in the ledger where an epic was
  expected is intake working correctly, not intake giving up.
