---
name: code-review
description: Two-axis review of a diff against a fixed point: Standards (does it follow this repo's conventions?) and Spec (does it do what was asked?), run as parallel subagents over a shared code-smell baseline. Read when reviewing a branch, a PR, or a change before it ships.
---

# Code Review — two axes, never merged

Two-axis review of the diff between `HEAD` and a fixed point the
operator supplies:

- **Standards** — does the code conform to this repo's documented
  coding standards?
- **Spec** — does the code faithfully implement the originating
  issue or spec?

Both axes run as **parallel subagents** so they don't pollute each
other's context, then this skill aggregates their findings.

## Process

### 1. Pin the fixed point

Whatever the operator said is the fixed point — a commit SHA, branch
name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask.

Capture the diff command once: `git diff <fixed-point>...HEAD`
(three-dot, so the comparison is against the merge-base). Also note
the commit list via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git
rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or an
empty diff should fail here — not inside two parallel subagents.

### 2. Identify the spec source

The caller usually supplies the spec source directly — an issue, a
spec file, or a commit range. Search for it yourself only when they
didn't, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`,
   GitLab `!67`, etc.).
2. A path the operator passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the
   branch name or feature.
4. If nothing is found, ask the operator where the spec is. If they
   say there isn't one, the **Spec** subagent skips and reports "no
   spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such
as `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `AGENTS.md`, or specs
under `docs/`.

On top of whatever the repo documents, the Standards axis always
carries the **smell baseline** below — a fixed set of Fowler code
smells (*Refactoring*, ch. 3) that applies even when a repo documents
nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins;
  where it endorses something the baseline would flag, suppress the
  smell.
- **Always a judgement call.** Each smell is a labelled heuristic
  ("possible Feature Envy"), never a hard violation — and, like any
  standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the
diff:

- **Mysterious Name** — a function, variable, or type whose name
  doesn't reveal what it does or holds. → rename it; if no honest
  name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than
  one hunk or file in the change. → extract the shared shape, call
  it from both.
- **Feature Envy** — a method that reaches into another object's
  data more than its own. → move the method onto the data it
  envies.
- **Data Clumps** — the same few fields or params keep travelling
  together (a type wanting to be born). → bundle them into one
  type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a
  domain concept that deserves its own type. → give the concept its
  own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same
  type recurs across the change. → replace with polymorphism, or
  one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits
  across many files in the diff. → gather what changes together
  into one module.
- **Divergent Change** — one file or module is edited for several
  unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks
  added for needs the spec doesn't have. → delete it; inline back
  until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller
  shouldn't depend on. → hide the walk behind one method on the
  first object.
- **Middle Man** — a class or function that mostly just delegates
  onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or
  overrides most of what it inherits. → drop the inheritance, use
  composition.

### 4. Dispatch both axes in parallel

Run both axes as a single `task` tool call, one `tasks[]` batch
holding both briefs, `agent: "scout"` for each — both axes are
read-only investigation, nothing here writes to the repo. Isolation
is the point: each axis reasons over its own context, uncontaminated
by the other's findings, which is why they run as two separate
agents rather than one pass over the diff.

**Standards task** — include:

- The full diff command and commit list.
- The standards-source files found in step 3, **plus the smell
  baseline from step 3** pasted in full — the subagent has no other
  access to it.
- The brief: "Report — per file/hunk where relevant — (a) every
  place the diff violates a documented standard: cite the standard
  (file + the rule); and (b) any baseline smell you spot: name it
  and quote the hunk. Distinguish hard violations from judgement
  calls — documented-standard breaches can be hard, but baseline
  smells are always judgement calls, and a documented repo standard
  overrides the baseline. Skip anything tooling enforces. Under 400
  words."

**Spec task** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are
  missing or partial; (b) behaviour in the diff that wasn't asked
  for (scope creep); (c) requirements that look implemented but
  where the implementation looks wrong. Quote the spec line for
  each finding. Under 400 words."

If the spec is missing, skip the Spec task and note this in the
final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings,
verbatim or lightly cleaned. Do **not** merge or rerank findings —
the two axes are deliberately separate (see *Why two axes*).

End with a one-line summary: total findings per axis, and the worst
issue *within each axis* (if any). Don't pick a single winner across
axes — that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing →
  **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the
  project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.