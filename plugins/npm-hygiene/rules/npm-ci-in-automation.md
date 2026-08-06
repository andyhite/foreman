---
description: A bare npm install re-resolves and rewrites the lockfile — reproducing a recorded tree is npm ci
condition: '\bnpm\s+(install|i)\b(?![^\n|;&]*\s(?!-)[\w@./])'
scope: "tool:bash"
interruptMode: tool-only
---

`npm install` and `npm ci` are not two spellings of the same thing:

- **`npm install` is a resolver run that writes back.** It re-solves ranges
  in `package.json`, may pick a newer version that still satisfies them, and
  updates `package-lock.json` as a side effect. The lockfile you had is not
  necessarily the lockfile you end up with.
- **`npm ci` installs exactly the lockfile.** It wipes `node_modules` first,
  never writes to `package-lock.json`, and exits non-zero when the lockfile
  and `package.json` disagree instead of quietly reconciling them.
- CI jobs, containers, release builds, and any script that must produce the
  same tree twice use `npm ci`. So does reproducing a bug — an install that
  can drift is not a reproduction.
- `npm ci` requires a lockfile and ignores per-package arguments; it is
  install-everything-as-recorded or nothing.

This rule deliberately only fires on an install with **no package argument** —
`npm install react` is you changing dependencies on purpose, and the lockfile
diff is the deliverable. A bare `npm install` is you asking for the recorded
tree, which is the case `npm ci` exists for, and where a silent re-resolution
becomes a dependency change riding along in an unrelated commit.
