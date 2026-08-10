# craft

Ten model-invoked reference skills for the *thinking* around a change:
settling a decision, naming a domain, placing a seam, writing a test worth
keeping, diagnosing a real bug, reviewing a diff. Nothing here knows about
issue trackers, boards, or any particular workflow — install it in any repo.

| Skill | Read when |
|---|---|
| `grilling` | A plan or decision needs the operator, and guessing would be worse |
| `domain-modeling` | Terminology is drifting, or a decision is worth an ADR |
| `codebase-design` | Designing a module, or deciding where a seam goes |
| `tdd` | Before writing any test, and on every red-green cycle |
| `code-review` | Reviewing a branch, a PR, or a change before it ships |
| `diagnosing-bugs` | Something is broken, throwing, failing, flaky, or slow |
| `prototype` | A decision can't be settled in conversation |
| `research` | A decision depends on docs or source you haven't read |
| `resolving-merge-conflicts` | A rebase or merge stopped on a conflict |
| `writing-for-agents` | Creating or editing a skill, rule, agent, or command |

All ten are **model-invoked**: they carry no commands and are reached by
description, either by the agent noticing the trigger or by another skill
naming them. That is why they are references rather than procedures — each
one is the answer to "how should this be done", available at the moment the
question comes up.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install craft@omp-foreman
```

Independent of every other plugin in this marketplace — install it alone in
any repo. The `foreman` plugin does declare `craft` as a requirement
(`omp.requiresPlugins`), so `/foreman:init` installs it for you and
`/foreman:doctor` reports it missing; that edge runs one way only, and
nothing here references foreman.

## Provenance

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills)
(MIT, Copyright (c) 2026 Matt Pocock) — see [`NOTICE`](NOTICE). The
adaptation is not a copy: Claude Code specifics (`/slash` invocation,
`disable-model-invocation`, `claude --bg`, `/clear` and `/compact` as
phase-boundary moves) are replaced with their omp equivalents (`skill://`
references, the `task` tool with `scout`/`task` agents, `hub` for
coordination), and the prose is re-cut to match this marketplace's house
style. The discipline is his; the packaging is ours.
