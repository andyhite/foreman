---
description: An ad-hoc `pip install <package>` with no version is invisible to the next checkout and to CI — record the dependency, then install from the record
condition: '\bpip3?\s+install(?![^&|;\n]*\s-(?:r\b|-requirement|e\b|-editable))(?:\s+(?:-U|-q|-v|--upgrade|--quiet|--verbose|--no-cache-dir|--pre|--user)\b)*\s+(?!(?:pip|setuptools|wheel|pip-tools)(?![\w.-]))[A-Za-z][A-Za-z0-9._-]*(?<!\.whl)(?<!\.zip)(?<!\.gz)(?![\w.\[=<>~!@:+/-])'
scope: "tool:bash"
interruptMode: tool-only
---

That install has no version specifier and no requirements file behind it:

- It exists only in your virtualenv. A fresh clone, a rebuilt venv, and CI all
  install from the declared dependencies, so the import you just enabled will
  fail everywhere except here.
- Unpinned means pip resolves whatever is newest **today**. The same command a
  month from now installs a different version, which makes the resulting
  breakage untraceable to any change in the repo.
- Declare it first: add the requirement to `requirements.txt`, or to the
  `[project] dependencies` table in `pyproject.toml` (a dependency group or an
  optional-dependencies extra for dev-only tools). Then install from that file
  — `pip install -r requirements.txt` or `pip install -e .` — so the
  environment and the declaration cannot disagree.
- Pin at the granularity the project already uses rather than introducing a
  second convention: exact `==` if neighbouring entries are exact, `~=` or a
  `>=,<` range if they are ranges.

Trying a package out to see whether it's the right one is a legitimate reason
to install it ad hoc — it is not a reason to leave it undeclared. Record it in
the same change that starts importing it.
