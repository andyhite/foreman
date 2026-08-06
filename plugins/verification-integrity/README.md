# verification-integrity

Two tool-call interrupt rules for the same sin through two different doors:
making the build look green without making it green. Nothing here knows
about issue trackers, boards, or any particular workflow — install it in any
repo.

| Rule | Fires on | Point |
|---|---|---|
| `test-integrity` | `.only(`, `.skip(`, `xit`/`fit`/`xdescribe`, `retries: N`, `--update-snapshots` | A red test is evidence. Don't shrink, mute, retry, or blind-accept your way past it. |
| `hooks-are-the-gate` | `--no-verify` | Skipping hooks is legitimate only when the failure is provably not yours — and then you say so. |

Both are scoped `tool:bash` with `interruptMode: tool-only`, so they fire on
actual shell execution — never on a `write`/`edit` that merely *mentions* one
of these patterns in prose or a code block.

Note that `test-integrity`'s condition also matches `.only(`/`.skip(` inside
a shell command line, which is where these usually surface in an agent
session (a `git commit` after adding one, a targeted test invocation). It is
deliberately not scoped to file content — that produced false positives on
every skill or doc that discussed the pattern.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install verification-integrity@omp-foreman
```

Independent of the `foreman` plugin in the same marketplace — install either,
both, or neither.
