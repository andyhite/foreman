---
description: Suppressing pip's resolver with --no-deps, --force-reinstall, or --ignore-installed papers over a conflict — the environment it leaves cannot be rebuilt from the requirements file
condition: '\bpip3?\s+install[^&|;\n]*\s--(no-deps|force-reinstall|ignore-installed)\b'
scope: "tool:bash"
interruptMode: tool-only
---

That flag suppresses pip's resolver instead of resolving the conflict:

- **`--no-deps`** installs the package and skips its dependency tree. The
  import works until the first call into a missing or too-old transitive
  dependency, and the traceback then names that library, not your install.
- **`--force-reinstall`** reinstalls packages that already satisfied the
  requirement, so the environment stops matching what the requirements file
  resolves to and the next clean install produces something different.
- **`--ignore-installed`** overwrites files pip did not record as owned by the
  new distribution, interleaving two versions' files in one `site-packages`.
- A resolver error is a **statement about the requirements**: two pins are
  incompatible. Fix it where it lives — loosen or bump the conflicting pin,
  add a constraint, or drop one of the two packages. If the environment is
  already wrong, delete the venv and reinstall from the requirements file.

The one honest `--no-deps` is installing into a **deliberately pre-resolved
environment** — a container layer that already installed a fully pinned
requirements file, so every dependency is present by construction and
re-resolving would only refetch. If that is the case, say so and name the file
that did the resolving.
