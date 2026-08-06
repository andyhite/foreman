---
description: A crates.io release is permanent — a version can be yanked but never replaced, so `cargo publish` spends that number forever
condition: '\bcargo\s+publish\b(?![^\n]*\s(?:--dry-run|-n)\b)'
scope: "tool:bash"
interruptMode: tool-only
---

`cargo publish` uploads an immutable artifact to a registry:

- **Yank is not delete.** A yanked version stops being chosen by new
  resolutions, but the `.crate` file stays downloadable forever and every
  lockfile that already pinned it keeps building against it.
- **The version number is spent.** You cannot re-upload `1.2.3` with the fix;
  you publish the next version and the broken one exists permanently.
- **Dry run first.** `cargo publish --dry-run` packages and compiles the crate
  exactly as the registry will, then prints the file list. Read that list — an
  `include`/`exclude` mistake ships fixtures, local credentials, or a crate
  missing the sources it needs to build.
- **Confirm the version bump** in `Cargo.toml` against the changelog and the
  tag you intend to push, and publish from a clean tree: cargo refuses a dirty
  working directory without `--allow-dirty` precisely so the artifact matches
  a commit someone can find.
- **A revert does not undo it.** The only recovery is yank plus a new version,
  and everyone who already resolved the bad one keeps it.

If the version, the packaged file list, and the tag are not all confirmed, run
the dry run — it costs one command; the mistake costs a version number.
