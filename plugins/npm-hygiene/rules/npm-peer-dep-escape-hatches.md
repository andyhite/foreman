---
description: --legacy-peer-deps, --force, and --omit=optional suppress npm's resolver checks — the tree they install can break at runtime instead of at install time
condition: '\bnpm\s+[^|;&\n]*(--legacy-peer-deps|--force|--omit=optional)'
scope: "tool:bash"
interruptMode: tool-only
---

Those flags do not fix a conflict; they tell npm to stop reporting one:

- **`--legacy-peer-deps` restores npm 6 behaviour** — peers are ignored
  rather than installed and checked. The install succeeds and you get a tree
  where a package runs against a peer version it never declared support for,
  so the failure lands at runtime, far from the command that caused it.
- **`--force` is broader**: it overrides conflicting resolutions, reinstalls
  over cache-integrity failures, and demotes fatal errors to warnings. The
  resulting tree goes into the lockfile, so the override becomes the default
  for everyone.
- **`--omit=optional` skips optional dependencies**, including the
  platform-specific binaries many toolchains ship that way — fine locally,
  missing for whoever builds on another platform.
- The real fix is upstream: correct the offending range, bump the package
  that declares the stale peer, or scope a single deliberate `overrides`
  entry in `package.json`, which is reviewable.

A legitimate use exists — a known upstream peer-range bug, already fixed but
unreleased. Then it is a documented decision: record the package, the
upstream issue, and the removal condition in the commit body.
