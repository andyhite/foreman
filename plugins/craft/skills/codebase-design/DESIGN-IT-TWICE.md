# Design It Twice — compare interfaces before committing

Explore alternative interfaces for a chosen deepening candidate before
committing to the first idea. Use the vocabulary in [SKILL.md](SKILL.md):
**module**, **interface**, **seam**, **adapter**, and **leverage**.

## 1. Frame the problem space

Write a user-facing explanation before dispatching design agents. Include:

- the constraints every new interface must satisfy;
- the dependencies it relies on and their categories from
  [DEEPENING.md](DEEPENING.md); and
- a rough illustrative code sketch that makes the constraints concrete
  without proposing an interface.

Show this frame to the user, then proceed immediately. The user can consider
the problem while the agents work concurrently.

## 2. Dispatch competing designs

Make **one `task` tool call** with three or more entries in a single
`tasks[]` batch. One call is load-bearing: it makes the independent designs
run concurrently instead of letting an earlier proposal anchor a later one.
Use the `task` agent because interface design requires judgement.

Give every entry its own complete technical brief. Name the relevant file
paths, coupling details, dependency category from
[DEEPENING.md](DEEPENING.md), and what sits behind the seam. Include both
[SKILL.md](SKILL.md) vocabulary and the target repository's `CONTEXT.md`
vocabulary so every proposal uses the architecture language and the domain
language consistently.

Assign a different constraint to each brief:

1. **Minimal interface:** aim for one to three entry points and maximise
   leverage per entry point.
2. **Maximum flexibility:** support many use cases and extension paths.
3. **Common caller:** make the default use case trivial for the most common
   caller.
4. **Ports and adapters, when applicable:** design around cross-seam
   dependencies.

Add more briefs when another materially different constraint exists. Every
brief must name its constraint and repeat these five required outputs:

1. **Interface:** types, methods, parameters, invariants, ordering, and error
   modes.
2. **Usage example:** how callers use the interface.
3. **Hidden implementation:** what the module hides behind the seam.
4. **Dependency strategy:** ports and adapters, following
   [DEEPENING.md](DEEPENING.md).
5. **Trade-offs:** where leverage is high and where it is thin.

Require radically different interfaces rather than variants of one shape.
Read each completed result from its `agent://` artifact before comparing.

## 3. Present and compare

Present the designs sequentially so the user can absorb each one. Then
compare them in prose against three criteria:

- **Depth:** how much leverage the interface gives each caller.
- **Locality:** where change, knowledge, and verification concentrate.
- **Seam placement:** where variation enters and which adapters make each
  seam real.

Recommend the strongest design and explain why. Propose a hybrid when
specific elements combine cleanly, but remain opinionated: the user needs a
strong read rather than an unranked menu.
