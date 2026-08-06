---
description: Bare python may not be the project interpreter — uv run guarantees the synced environment, while a plain invocation uses whatever PATH resolves to
condition: '(?<!run\s)\bpython3?\s+-m\s+|(?<!run\s)\bpython3?\s+\S+\.py\b'
scope: "tool:bash"
interruptMode: tool-only
---

`python` resolves through `PATH`, and **`PATH` is not the project.** With no
activated venv it lands on the system interpreter, a version-manager shim,
or whichever venv was activated last in this shell:

- The confusing outcome is the *good* one — `ModuleNotFoundError` at least
  says the interpreter is wrong.
- The dangerous outcome is success against a different dependency set:
  tests pass, a script writes real data, and the versions in play are not
  the versions in `uv.lock`.
- uv needs no activated venv, so an unactivated shell looks identical to a
  correct one right up until something imports.
- **A module:** `uv run -m <module>`. **A script:** `uv run <script>.py`, or
  `uv run <console-script>` for a declared entry point.
- **A tool:** `uv run pytest`, `uv run ruff check` — uv syncs first, so the
  run always matches the lockfile.

A throwaway `python -c` or `python --version` outside the project is fine —
neither imports project code, so there is no environment to get wrong.
