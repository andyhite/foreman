---
description: A bare `cargo update` bumps the whole transitive graph in one unreviewable diff — update the crate you actually mean
condition: '\bcargo\s+update\b(?![^\n]*\s(?:-p\b|-p\w|--package\b))'
scope: "tool:bash"
interruptMode: tool-only
---

`cargo update` with no package argument re-resolves every dependency to the
newest version the constraints allow:

- The result is a lockfile diff touching dozens of crates nobody named,
  interleaved with whatever you were actually doing. That diff does not get
  read — it gets approved on the strength of a green check.
- **Update the crate you mean**: `cargo update -p <crate>`, or
  `cargo update -p <crate> --precise <version>` to pin the exact hop.
- A transitive crate is still nameable. `cargo tree -i <crate>` shows what
  pulls it in, and `-p` takes it directly.
- Adding a dependency is `cargo add <crate>` — it edits `Cargo.toml` and the
  lock together without disturbing the rest of the graph.
- A full refresh is a legitimate change **on its own commit**: nothing else in
  the diff, and the commit body states why (an advisory, a scheduled bump) and
  what you ran to verify the tree still builds and passes.

When something breaks after a wide update, `git diff Cargo.lock` is the suspect
list — keep that diff small enough to actually read.
