---
description: Installing outside a virtualenv writes into an interpreter you don't own — the dependency set stops being reproducible and OS tooling on that interpreter can break
condition: '\bsudo\s+(-\w+\s+)*(python3?\s+-m\s+)?pip3?\s|\bpip3?\s+install[^&|;\n]*\s(--user|--break-system-packages)\b'
scope: "tool:bash"
interruptMode: tool-only
---

That install targets **system or user-global `site-packages`**, not a
project environment:

- The result is unreproducible. Nothing in the repo records it, so the next
  checkout and CI get a different environment than yours, and the failure
  shows up as "works on my machine".
- `sudo pip` writes into the interpreter the OS depends on. Distro package
  managers own those files; overwriting a shared transitive dependency is how
  system tooling written in Python stops importing.
- `pip install --user` is the same problem one directory over — `~/.local`
  leaks across every project on the machine and shadows what the venv
  resolves.
- `--break-system-packages` is pip telling you it refused for a reason
  (PEP 668). Passing it is not a fix, it is an override.

Create and activate an environment first: `python -m venv .venv` then
`source .venv/bin/activate`. Confirm it took before installing — `$VIRTUAL_ENV`
is set to the venv path, and `pip -V` reports a path inside `.venv`. If you
need a tool globally rather than as a project dependency, that is what `pipx`
is for; it gives each tool its own venv instead of sharing one.
