---
description: --system and --break-system-packages install into the interpreter the OS owns — invisible to the lockfile, invisible to every other checkout, and able to break OS tooling
condition: '\buv\s+pip\s+(install|sync|uninstall)\b[^\n]*\s--(system|break-system-packages)\b|\bpip\d?\s+install\b[^\n]*\s--break-system-packages\b'
scope: "tool:bash"
interruptMode: tool-only
---

Those flags **bypass the project venv and write into the system
interpreter** — an interpreter the OS or distribution owns, not this
project:

- The install is invisible to `uv.lock` and `pyproject.toml`, so nothing
  records that the code now depends on it. It works here and fails
  everywhere else, CI included.
- It is invisible to every other checkout on the machine: a second clone
  gets a different dependency set from the same commit.
- System package managers install into that same interpreter and track its
  contents themselves. Overwriting what they own is what
  `--break-system-packages` is named after — OS tooling written in Python
  breaks when its dependencies shift underneath it.
- The damage outlives the project; deleting the directory undoes none of it.
- **Project work:** `uv sync`, then `uv run <cmd>`. **A standalone CLI:**
  `uv tool install <pkg>`. **One shot:** `uvx <pkg>`, installing nothing.

A container image where the system interpreter *is* the project environment
is the one exception — declare it in the image build, not interactively.
