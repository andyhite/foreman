---
description: Recursive force delete has no trash and no undo — and its blast radius is whatever the variable expanded to, including nothing
condition: '(^|[^\w-])rm\s+(?=(?:-[a-zA-Z-]+\s+)*-[a-zA-Z-]*[rR])(?=(?:-[a-zA-Z-]+\s+)*-[a-zA-Z-]*f)'
scope: "tool:bash"
interruptMode: tool-only
---

Recursive force delete is **unrecoverable** — no trash, no staging
area, nothing to check back out:

- **The damage scales with a variable that might be empty.** `rm -rf
  "$DIR/"` with `DIR` unset targets the filesystem root, and `-f`
  suppresses the one error that would have stopped it.
- **Echo the expansion first.** `echo "$DIR"` or `ls -d -- "$DIR"`
  costs one call and names what is about to disappear.
- **Delete a specific named path, not a glob.** `rm -rf build` is
  auditable; `rm -rf *` depends on the current directory being the one
  you assume it is.
- **Never combine it with an unquoted or unvalidated variable.** Guard
  it — `[ -n "$DIR" ] && [ -d "$DIR" ] && rm -rf -- "$DIR"` — or write
  the literal path.
- **While iterating, move instead of delete.** Rename to `<path>.bak`,
  remove it once the run is green.

Regenerable output — a build directory, a cache — is what these flags
are for. Source, config, and anyone's uncommitted work are not.
