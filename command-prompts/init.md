---
description: Scaffold this repo's foreman config, then dig for the roles it probably needs and the skills to map them to
---

Set up foreman for this project: create its config if it does not exist, then
propose a `roles:` mapping grounded in what this repo actually has, not a
generic template.

## 1. Scaffold

```bash
foreman init
```

Creates `.foreman/config.yml` at the repo root with a commented, empty
`roles:` skeleton — idempotent, refuses to touch a file that already exists.
If `foreman` is not on PATH, the herdr plugin is not installed
(`herdr plugin install andyhite/foreman/herdr`); stop and say so rather than
hand-writing the file, since the CLI is the only thing `--role` actually reads.

## 2. Find candidate skills

Two sources, both real — never invent a skill that does not exist:

- **Skills already available to you in this session.** You were handed a list
  of every discovered skill at session start (the `<skills>` catalogue in your
  own system prompt). Any of those is fair game for a role mapping.
- **Skills that live in this repo but may not be loaded into this session.**
  Glob for `SKILL.md` under the conventional locations — `skills/*/SKILL.md`,
  `.claude/skills/*/SKILL.md`, `.omp/skills/*/SKILL.md` — and read each one's
  frontmatter `description` to learn what it is for. A skill you find this way
  is still a legitimate candidate even though it is not in your own catalogue.

## 3. Infer the roles this project probably wants

A role only earns a place in `roles:` if a *found* skill actually fits it —
this step never fabricates a skill name to fill a slot. Ground the mapping in
real signal from the repo, not a fixed checklist:

- Read `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` and any repo-rules files
  already loaded into your context for a documented house process (a required
  review step, a TDD mandate, a security pass) — that is the strongest signal
  for what a role name should be.
- Match each documented process, and each skill's own `description`, against
  common dispatch conventions: `review` (code review before merge), `implement`
  (the house way of building a feature), `test` (a TDD or test-first
  convention), `security-review`, `design-review`. Use these as candidate
  names, not a mandatory list — map only the ones a discovered skill actually
  covers.
- Prefer an exact or near-exact conceptual match (a skill literally named
  `code-review` maps cleanly to `review`) over a loose guess. When nothing
  found fits a plausible role well, leave that role out rather than mapping it
  to something approximate.

## 4. Write it

Edit `.foreman/config.yml`'s `roles:` block directly with the mapping you
settled on, preserving any lines already there (a rerun must not clobber a
mapping the user already wrote by hand — merge in only roles that are still
absent). Uncomment the `roles:` key if the scaffold's example was still
commented out.

## 5. Report

Print the resulting mapping and, for each entry, the one-line reason it was
chosen (which repo signal or skill matched). Note that `.foreman/config.yml`
is a normal file in the checkout — it shows up in `git status`/`git diff` like
any other change, and is meant to be reviewed and committed like one. Point at
`foreman roles` to re-verify the mapping, and mention that entries can be
edited or removed by hand at any time; nothing else in foreman depends on
what this command chose beyond what is written in that file.

$ARGUMENTS
