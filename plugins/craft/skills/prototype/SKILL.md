---
name: prototype
description: Build throwaway code that answers one design question: a logic or state model you need to feel, or a UI you need to see. Read when a decision can't be settled in conversation and needs something runnable.
---

# Prototype — throwaway code that answers one question

A prototype is **throwaway code that answers a question**. The question
decides the shape.

## Pick a branch

Identify which question is being answered — from the operator's prompt, the
surrounding code, or by asking if the operator is around:

- **"Does this logic or state model feel right?"** Read [LOGIC.md](LOGIC.md).
  Build a single shareable HTML file — free-play buttons plus tabbed guided
  walkthroughs — that pushes the state machine through cases that are hard
  to reason about on paper, and that a non-developer can drive.
- **"What should this look like?"** Read [UI.md](UI.md). Generate several
  radically different UI variants on a single route, switchable through a
  URL search parameter and a floating bottom bar.

The two branches produce very different artifacts. Choosing the wrong one
wastes the prototype. If the question is genuinely ambiguous and the
operator is unavailable, default to whichever branch better matches the
surrounding code — a backend module points to logic; a page or component
points to UI — and state the assumption at the top of the prototype.

## Rules that apply to both

1. **Make it throwaway from day one, and mark it clearly.** Locate the
   prototype close to where it will be used, next to the module or page it
   explores, so the context stays obvious. Name it so a casual reader can
   see it is not production code. Follow the project's routing convention
   for throwaway UI routes; do not invent a new top-level structure.
2. **Make it trivial to run.** Start a UI prototype with one command in the
   project's task runner: `pnpm <name>`, `python <path>`, `bun <path>`, or
   the local equivalent. Make a logic demo one HTML file the operator can
   double-click. Starting either should require no decisions.
3. **Use no persistence by default.** Keep state in memory. Persistence is
   the thing the prototype might be checking, not a dependency it should
   acquire. If the question explicitly involves a database, use a scratch
   database or a local file named clearly as `PROTOTYPE — wipe me`.
4. **Skip the polish.** Add no tests, no error handling beyond what makes
   the prototype runnable, and no abstractions. Learn the answer before the
   disposable code begins looking permanent.
5. **Surface the state.** After every action in a logic prototype, or every
   variant switch in a UI prototype, render the full relevant state so the
   operator can see what changed.
6. **Capture it when done.** Fold the validated decision into the real code.
   Keep the prototype itself on a throwaway branch, outside main, as a
   primary source. Record the verdict and the question it settled, then
   leave a pointer to that branch on the tracking issue. Main keeps only the
   validated decision.
