# uv-hygiene

Four tool-call interrupt rules for Python repos managed by
[uv](https://docs.astral.sh/uv/). They defend one invariant: `pyproject.toml`
and `uv.lock` describe the environment, and everything else is derived from
them.

| Rule | Fires on | Point |
|---|---|---|
| `uv-only` | `pip install`, `python -m pip install`, `poetry add`/`install`, `pipenv install`, `conda install` | The install never reaches `uv.lock`, and the next `uv sync` reverts it. Use `uv add` / `uv sync` / `uv run`. |
| `uv-lockfile` | writes to `**/uv.lock` | Generated resolver output — pins paired with hashes across platform markers. Regenerate with `uv lock`, `uv add`, or `uv sync`. |
| `uv-system-environment` | `uv pip install --system`, `--break-system-packages` | Writes into the OS-owned interpreter — unlocked, unshared, and able to break system tooling. Sync a project venv instead. |
| `uv-run-over-bare-python` | `python -m <module>`, `python <script>.py` | Bare `python` is whatever `PATH` resolves to, not the synced environment. `uv run` guarantees it. |

`uv-lockfile` is a path rule, so it fires on `write`/`edit` of the lockfile.
The other three are scoped `tool:bash` with `interruptMode: tool-only`, so
they fire on actual shell execution — never on a file that merely *mentions*
one of these commands in prose or a code block. `uv-run-over-bare-python` is
anchored narrowly enough to leave `python --version` and `python -c` alone,
and none of the command rules trip on `uv run python ...`.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install uv-hygiene@omp-foreman
```

Independent of every other plugin in this marketplace — it assumes only that
the repo uses uv, and shares no configuration with its siblings.
