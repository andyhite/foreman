---
name: charting
description: Charting a foggy idea as a map of decision tickets, then resolving the frontier until a real epic can be derived. Read when the destination is visible but the way there is not, or when working an existing chart.
---

# Charting — find the way before breaking down the work

Grooming can accept an idea as a task or an epic when the route to its
outcome is already visible. **Charting is the third accept path**: use it
when the destination is clear enough to name but the decisions needed to
reach it are still hidden by fog. It turns those decisions into tracker
issues and resolves them until grooming can derive a real epic breakdown
instead of inventing one.

Charting is also reached from `skill://prd-intake`: when a region of a
product document has a clear outcome but a fogged route, intake routes it to
a chart rather than guessing a breakdown. The chart graduates to an epic by
the same hand-off described in [Graduate to an epic](#graduate-to-an-epic).

Read `skill://tracker` before changing any issue, label, dependency, or
board status. Read every constant from `.omp/foreman.json`; names below such
as `labels.chart` and `labels.epic` are config keys, not literal labels.

## Plan, don't do

Charting produces **decisions, not deliverables**. Each ticket answers a
question that makes the route clearer. If a session starts implementing the
destination, it has left this skill; stop and hand the work to the proper
foreman stage.

The exception is a `task` ticket whose work must happen before a decision
can be made. It may expose facts or access, but it does not deliver part of
the destination.

Never resolve more than one decision ticket per session. Research tickets
are the exception because they are read-only and can run independently.

## Refer by name

Every map and ticket has a descriptive title. In narration, summaries, and
the map body, refer to each issue by its linked name, never by a bare issue
number. Names let the operator understand the route at a glance; numbers do
not.

## The map

The map is one issue labeled with `labels.epic` and `labels.chart`, linked
to the project board at `Backlog`. Its body has exactly this shape:

```markdown
## Destination

<What becomes reachable when the chart is complete.>

## Notes

<Domain context, standing preferences, and skills each session needs.>

## Decisions so far

- [<decision ticket title>](<link>) — <one-line gist>

## Not yet specified

<In-scope fog whose question cannot yet be stated precisely.>

## Out of scope

<Concepts deliberately beyond this destination, with the reason.>
```

The map is an **index, not a store**. A decision lives in exactly one place:
its ticket. The map links to that ticket and gives one line of orientation;
it never restates the decision. Open work is found through the map's
sub-issues, not copied into its body.

## Decision tickets

A decision ticket is an issue labeled with `labels.task` and `labels.chart`,
linked as a sub-issue of the map. Give it a precise question small enough
for one agent session:

```markdown
**Type:** grilling

## Question

<The decision or investigation this ticket resolves.>
```

`Type` is body metadata, not a label. Foreman creates one chart label, from
`labels.chart`; never invent labels for ticket types.

Put a ticket at `To Do` when all its prerequisites are settled and at
`Backlog` while any remain. Record prerequisite edges as native issue
dependencies using the tracker skill's recipe for epic subtasks. Create all
tickets first, then wire edges in a second pass because the edges need issue
identities. The **frontier** is the open, unblocked, unclaimed set of map
sub-issues.

Claim a frontier ticket by assigning it to yourself **before any work** so
concurrent sessions skip it. Then move it from `To Do` to `In Progress` per
the tracker lifecycle. Assignment is the concurrency claim; board status
communicates active work.

## Ticket types

Choose the type by how its question must be resolved:

- **`research`** — read primary sources or external documentation. Read
  `skill://research` and dispatch a `scout` through the `task` tool. Several
  independent research tickets may resolve in one session because the work
  is read-only.
- **`prototype`** — make a throwaway artifact to answer how something should
  look or behave. Read `skill://prototype` and keep the operator in the
  loop; the artifact raises the fidelity of the decision but is not product
  code.
- **`grilling`** — settle the decision with the operator. This is the
  default. Read `skill://grilling` alongside `skill://domain-modeling`.
  When terminology resolves, update the glossary at `docs.context`, or the
  relevant context reached through `docs.contextMap`. When a decision is
  hard to reverse and surprising without context, write its ADR under
  `docs.adr`. Record each artifact at the moment its decision resolves;
  configured `null` paths mean the repo has no such artifact.
- **`task`** — do enabling work that blocks a later decision, such as
  provisioning access or moving data so its shape can be inspected. This is
  the one type that does rather than decides. Keep it inside the chart only
  when it unblocks a decision and does not build the destination.

## Fog of war

Chart only what is visible. The test is whether the question can be stated
precisely **now**, not whether it can be answered now:

- Create a ticket when its question is precise, even if prerequisites block
  it.
- Keep it under `Not yet specified` when the question is still too vague.
  Do not pre-slice fog; one patch may later become several tickets or none.

`Not yet specified` contains only in-scope fog. It excludes resolved
decisions, live tickets, and out-of-scope work.

The destination fixes scope. Work beyond it belongs under `Out of scope`,
never in the fog, and never graduates onto the map. If an existing ticket
proves out of scope, close it, link it by name from `Out of scope`, and give
the reason. Do not list it under `Decisions so far`, because ruling out a
route is a boundary, not a step toward the destination.

## Record every resolution

A resolution is not recorded until all of these are true:

1. Put the answer in the decision ticket, with links to any supporting
   artifact.
2. Close the ticket and move it to `Done` using the tracker lifecycle.
3. Append its linked name and a one-line gist to the map's
   `Decisions so far` section.
4. Graduate anything the answer brought into focus: remove it from
   `Not yet specified`, create its decision ticket, link it as a sub-issue,
   and wire any dependency edges in a second pass.
5. Recompute which open tickets are now unblocked and move those from
   `Backlog` to `To Do`.

Edit the map every time a ticket resolves. A map that lags its tickets is
worse than no map because it is confidently wrong. If a resolution changes
or invalidates another ticket, update or close that ticket in the same pass.

## Chart it

Use this mode for a loose idea or idea issue:

1. **Name the destination.** Run `skill://grilling` with
   `skill://domain-modeling` to settle what the chart must make reachable.
   The destination sets the scope, so establish it first.
2. **Map breadth-first.** Grill across the whole space instead of following
   one thread deeply. Surface precise questions, their prerequisites, and
   the fog behind them. If no fog appears and the route is already clear,
   stop and ask the operator whether grooming should accept it directly as
   a task or epic.
3. **Create the map.** Apply `labels.epic` plus `labels.chart`, add it to the
   board at `Backlog`, fill `Destination` and `Notes`, leave
   `Decisions so far` empty, and sketch the fog under `Not yet specified`.
4. **Create the visible tickets.** Link each as a map sub-issue, set ready
   tickets to `To Do` and blocked tickets to `Backlog`, then wire native
   dependency edges in a second pass with `skill://tracker`.
5. **Dispatch research.** For every ready `research` ticket, dispatch a
   `scout` using `skill://research`; claim and record each ticket around the
   dispatch so the tracker remains authoritative.
6. **Stop.** Charting establishes the map and may resolve its read-only
   research tickets. It does not hand-resolve the other decisions or begin
   building.

## Work the map

Use this mode when given a map issue:

1. Load the map's low-resolution body and query its open sub-issues and
   native dependencies. Do not load every ticket body before it is relevant.
2. Choose the named ticket, or the first frontier ticket when none was
   named. Assign it to yourself before any work, then move it to
   `In Progress`.
3. Resolve it according to its `Type`, loading related ticket details only
   as needed. Consult the skills named in the map's `Notes`.
4. Record the resolution completely, including the map edit and anything
   that graduates from the fog.
5. Stop after that one ticket unless the remaining work is independent,
   read-only research.

Other sessions may work different frontier tickets concurrently. Re-read
tracker state before every claim and map edit rather than trusting the view
you loaded at the start.

## Graduate to an epic

When the frontier is empty and the destination is reachable, charting is
finished. It **hands off; it does not build**. Turn the map into the epic's
spec by removing `labels.chart` and rewriting the index into the normal epic
shape, or supersede it with a normal epic that links back to the map when the
decision history must remain intact. Then run the epic breakdown from
`skill://grooming` so its subtasks are derived from settled decisions rather
than guesses.

The temptation to keep going is the failure mode. Once the route is clear,
stop charting and hand the epic to delivery.
