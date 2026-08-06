---
description: --no-frozen-lockfile and pnpm install --force convert a loud lockfile disagreement into a silent re-resolution
condition: '\bpnpm\b[^\n&|;]*\s--no-frozen-lockfile\b|\bpnpm\s+(install|i|add|update)\b[^\n&|;]*\s--force(?!-)'
scope: "tool:bash"
interruptMode: tool-only
---

That flag disables the check that makes an install reproducible:

- **`--frozen-lockfile` is the default in CI** and whenever `pnpm-lock.yaml`
  is present. Its whole job is to fail when the lockfile and `package.json`
  disagree. `--no-frozen-lockfile` keeps the same disagreement and re-resolves
  around it, so the run goes green on a dependency graph that was never
  committed and that nobody else will install.
- The failure it suppresses is almost always a real, fixable fact: someone
  edited `package.json` without installing, or a merge landed one side of the
  pair. Run `pnpm install` locally, commit the updated lockfile, push that.
- **`pnpm install --force` is broader**, not gentler — it ignores the store
  cache and re-fetches and rebuilds every package unconditionally. If that
  makes a failing install pass, the interesting information is *which*
  corrupted cache entry or integrity mismatch it papered over.
- Reproducing a colleague's environment? Delete `node_modules` and run a plain
  `pnpm install` — that isolates the problem instead of hiding it.

Reach for these when you are deliberately debugging the store, never as a way
past a red install.
