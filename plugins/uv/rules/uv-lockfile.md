---
description: uv.lock is generated resolver output — hand-editing it desynchronizes pins from hashes and platform markers, and the next resolve discards the edit anyway
condition:
  - "**/uv.lock"
interruptMode: tool-only
---

`uv.lock` is **resolver output, not configuration** — one universal
resolution covering every platform, Python version, and extra the project
declares:

- Each entry pairs a pinned version with the distribution hashes uv verifies
  on install. Edit the version by hand and the hashes no longer describe the
  artifact, so installs fail verification instead of picking up the change.
- Entries are gated by environment markers (OS, architecture, Python
  version) and by extras and dependency groups. Editing one branch of that
  matrix leaves the rest inconsistent, and it breaks on a platform you are
  not testing on.
- **Change a dependency:** edit `pyproject.toml`, then `uv lock` — or skip
  the two-step with `uv add` / `uv remove`.
- **Refresh pins:** `uv lock --upgrade`, or `--upgrade-package <pkg>` for
  one. **Apply to the venv:** `uv sync`.

A merge conflict here is resolved the same way — take either side, then
re-run `uv lock` to produce a coherent file.
