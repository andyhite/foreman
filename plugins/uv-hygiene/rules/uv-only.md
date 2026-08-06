---
description: This project is managed by uv — pip, poetry, pipenv, and conda mutate the environment without touching uv.lock, and the next uv sync silently reverts the change
condition: '(?<!uv\s)\bpip\d?\s+install\b|\bpoetry\s+(add|install|lock)\b|\bpipenv\s+(install|update)\b|\bconda\s+install\b'
scope: "tool:bash"
interruptMode: tool-only
---

**uv owns both the environment and the lockfile.** `pyproject.toml` declares
intent, `uv.lock` records the resolution, and the venv is a derived artifact
rebuilt from those two:

- `pip install` writes into the venv and nothing else — the dependency never
  reaches `pyproject.toml`, the resolution never reaches `uv.lock`, so the
  install exists only on this machine.
- The next `uv sync` rebuilds from the lockfile and removes it. Code that
  worked an hour ago fails on an import, which reads as a mysterious
  regression rather than the uninstall it is.
- `poetry`, `pipenv`, and `conda` go further and claim resolution itself,
  writing a competing lockfile and a second source of truth.
- **Add or drop:** `uv add <pkg>` / `uv remove <pkg>` — both update
  `pyproject.toml` and `uv.lock` together.
- **Materialize:** `uv sync` (`--frozen` when the lockfile must not
  re-resolve). **Run anything:** `uv run <cmd>`, which syncs first.

`uv pip install` is legitimate for one case — throwaway inspection of an
environment you are about to discard. If the package should still be there
tomorrow, it belongs in `uv add`.
