---
name: writing-for-agents
description: Reference for writing any document an agent consumes: a skill, an AGENTS.md, a doc behind a pointer. Read when creating or editing a skill, rule, agent, or command file.
---

# Writing for Agents — predictable prose through structure

Write documents so an agent takes the same *process* every run rather than
producing the same output. The packaging differs between a skill, an
`AGENTS.md`, and a document behind a pointer; the writing levers do not.

When writing a skill, read
[SKILL-MECHANICS.md](SKILL-MECHANICS.md) for omp frontmatter, invocation
choice, splitting by invocation, and router commands.

## Context pointers

A **context pointer** is a reference held in the agent's context that names
out-of-context material and encodes the condition for reaching it. A skill's
description is one. A line in `AGENTS.md` naming another document is the
same object.

The pointer's *wording*, not its target, decides when the agent reaches the
material and how reliably. A must-have target behind a weakly worded pointer
is a variance bug. Sharpen the wording before inlining the material; inline
only when sharpening the pointer fails.

Make every pointer do two jobs: state what the material is and list the
**branches** that should trigger reaching it. A branch is a distinct case
the document handles, so different runs take different paths through it.
Always-loaded words cost attention on every turn, so prune a pointer harder
than its body:

- **Front-load the leading word** where the pointer does its triggering
  work.
- **Keep one trigger per branch.** Collapse synonyms that rename one branch;
  retain genuinely different cases.
- **Cut identity the body already carries.** Let the target explain itself
  after the pointer fires.

## The two loads

Every document and pointer spends one of two budgets:

- **Context load** is the cost of always-loaded material on the model: an
  `AGENTS.md` line, a skill description, or anything present on every turn.
  It spends tokens and attention whether or not it fires.
- **Cognitive load** is the cost on the human: remembering which documents
  exist and when to reach for each. **The human is the index.** Cognitive
  load is the price of human agency, so spend it where human judgement
  matters and remove it where it does not.

Material reached through a pointer escapes most context load at the price of
the pointer's line. Material with no pointer rides entirely on cognitive
load.

## Information hierarchy

Documents mix two content types: **steps**, the ordered actions an agent
performs, and **reference**, the definitions, rules, and facts it consults.
Place each piece on a three-tier hierarchy ranked by how immediately the
agent needs it:

1. **In-file step** — the primary tier: what the agent does, in order.
2. **In-file reference** — material consulted on demand. A flat peer set of
   rules can legitimately live on this tier.
3. **Disclosed reference** — material in another file, reached through a
   context pointer only when its branch fires. It may be a sibling file or
   external reference shared by several documents.

Push too little down and the top bloats. Push too much and needed material
becomes hidden. Make the trade deliberately.

**Progressive disclosure** moves material down the hierarchy and behind a
pointer so the top stays legible. It protects the hierarchy rather than
merely saving tokens. Branching is the cleanest test: inline what every
branch needs and disclose what only some branches need. Reference that
interrupts an ordered procedure makes attention unreliable, so move it
behind a pointer when only one branch needs it.

**Co-location** decides what sits together after the hierarchy decides the
tier. Keep a concept's definition, rules, and caveats under one heading so
reading one part brings its neighbours with it. Grouped material reads like
documentation written for the agent; scattered material does not. Scattering
fragments one meaning across a file, while duplication repeats the same
meaning in several places.

**Sprawl** is a document too long even though every line is live and unique.
Attention thins across the excess, and each line becomes another fact to
keep relevant. Cure sprawl with the hierarchy: disclose reference behind
pointers and split by branch or sequence so each path carries only what it
needs.

## Steps and completion criteria

End every step with a **completion criterion**: the condition that tells the
agent the work is done. Grade it on two properties:

- **Clarity:** can the agent distinguish done from not done? A vague bound
  such as "understanding reached" invites **premature completion**. Visible
  **post-completion steps** pull attention toward being finished. Sharpen
  the bound first. When the bound is irreducibly fuzzy and the agent still
  rushes, split the sequence across a real context break such as a handoff
  or subagent dispatch; an inline reference leaves the later steps visible.
- **Demand:** how much does the criterion require? "Every modified model
  accounted for" drives more **legwork** than "produce a change list."
  Demand is not limited to steps: "every rule applied" can bind a flat body
  of reference and give it an exhaustiveness bar.

Prefer criteria that are both checkable and exhaustive.

## When to split

Splitting one document into two spends one of the two loads, so make the cut
earn its cost:

- **By sequence:** split where visible post-completion steps tempt the agent
  to rush the current step. A real context break hides the later sequence
  and permits more legwork on the current work.
- **By invocation:** split when material has an independently useful trigger
  or is reached by a different actor. Apply the omp-specific trade in
  [SKILL-MECHANICS.md](SKILL-MECHANICS.md).

## Leading words

A **leading word** is a compact concept already present in the model's
pretraining that the agent can think with while running a document:
*lesson*, *fog of war*, or *tracer bullets*. Repeat the token, not its full
definition, to anchor a region of behaviour and recruit the model's existing
priors. Coin a term only when an existing one will not do; a new term costs
the definition tokens that a pretrained one supplies.

A leading word anchors twice. In the body, it anchors **execution**: each
occurrence calls up the same behaviour. In a pointer, it anchors
**invocation**: shared language across prompts, documents, and code makes the
agent reach the material more reliably.

Refactor repeated explanations into leading words:

- "fast, deterministic, low-overhead" becomes *tight* — a *tight* loop.
- "a loop you believe in" becomes *red* — the loop either goes *red* on the
  bug or it does not.

**Negation** is the neighbouring failure mode. A prohibition activates the
forbidden behaviour and makes it more available, while the negation is a
weak modifier. Prompt the **positive** target so attention lands on what to
do. Reserve prohibitions for hard guardrails that cannot be phrased
positively, and pair each one with the positive behaviour.

## Pruning

- Keep each meaning in a **single source of truth**. Duplication costs tokens
  and maintenance, and inflates a meaning's apparent rank in the hierarchy.
  A leading word repeats a token deliberately; it does not repeat the
  meaning.
- Treat the **environment as a source of truth**: scripts, config files,
  directory layout, and `--help` output. Documentation that restates an easy
  lookup is a cache that can go stale. Record what inspection cannot reveal:
  the unwritten convention, the reason behind a choice, or the hidden
  gotcha.
- Check every line for **relevance** to what the document does. Exposition,
  undisclosed branches, and stale rules lose relevance. Without pruning,
  **sediment** accumulates because adding feels safe while removing feels
  risky.
- Hunt **no-ops** sentence by sentence. Ask whether the instruction changes
  model behaviour from its default. Settle disagreements by running the
  document rather than debating the default. Delete a failed sentence
  rather than trimming it; replace a weak leading word with one strong
  enough to move behaviour.
