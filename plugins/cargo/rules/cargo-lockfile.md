---
description: Cargo.lock is the resolver's output, not a file to hand-edit — a lock that disagrees with Cargo.toml fails the build instead of fixing it
condition:
  - "**/Cargo.lock"
interruptMode: tool-only
---

`Cargo.lock` records the exact resolved version and checksum of every crate
in the graph. Cargo owns that file:

- **Binaries, workspaces that build one, and anything you deploy commit it** —
  the lock is what makes the build reproducible on CI, on another machine, and
  on a bisect six months out. Do not gitignore it there.
- **A published library conventionally does not commit it**: downstream
  consumers re-resolve against their own graph and ignore yours, so the lock
  only records whichever versions your CI happened to pick that day.
- **Regenerate, never retype.** `cargo add <crate>`, `cargo update -p <crate>`,
  or any `cargo build`/`cargo check` rewrites the lock from `Cargo.toml`.
- **A hand edit desyncs the two.** A version bumped by hand leaves the recorded
  checksum wrong and the transitive graph stale — the next resolve silently
  overwrites your edit, and a `--locked`/`--frozen` build fails outright first.
- **Merge conflicts resolve by re-resolving**: take either side wholesale, run
  `cargo check`, and commit the lock cargo produces.

If the intent is a different version, the change belongs in `Cargo.toml` — the
lock is the output of that decision, not the place to make it.
