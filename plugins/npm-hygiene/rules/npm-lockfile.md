---
description: package-lock.json is generated and integrity-checked — a hand-edited version or URL either fails subresource verification or defeats it
condition:
  - "**/package-lock.json"
  - "**/npm-shrinkwrap.json"
interruptMode: tool-only
---

`package-lock.json` (and its published twin `npm-shrinkwrap.json`) is
**generated output**, not source:

- Every package entry carries an `integrity` subresource hash of the exact
  tarball npm resolved. Edit a `version` or `resolved` URL by hand and either
  the install fails verification, or you "fixed" the hash to match and just
  disabled the only check that the bytes on disk are the bytes npm chose.
- The file also encodes the resolved tree shape — hoisting, nesting, which
  duplicate satisfies which range. Retyping it describes a tree npm would
  never produce.
- Change a version through `package.json` and re-run `npm install`; pin one
  package with `npm install <pkg>@<version>`. Commit the regenerated lockfile
  in the **same commit** as the manifest change.
- **Merge conflicts are never resolved by hand.** Take either side wholesale,
  re-run `npm install`, and commit the result.
- If `npm ci` reports the lockfile is out of sync, the fix is `npm install`,
  not an edit that makes the error go away.

Deleting the lockfile to "start clean" throws away every pinned transitive
version — that is a whole-tree dependency bump, and needs describing as one.
