---
description: Scaffold this repo's foreman config, then dig for the roles it probably needs, the skills to map them to, and any existing model convention to pin
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

Two sources, both real — never invent a skill that does not exist. Always run
both; do not stop at the first:

- **Skills already available to you in this session.** You were handed a list
  of every discovered skill at session start (the `<skills>` catalogue in your
  own system prompt). Treat this as a starting point only — in practice it is
  routinely a curated *subset*, not the full install, even in a normal
  session with nothing explicitly disabled. Never conclude "no skill fits"
  from this list alone.
- **Every `SKILL.md` under the real install roots, project and global alike.**
  This is not a fallback for when something looks filtered — run it every
  time, unconditionally, before deciding a role has no match. A skill
  installed globally for this user (e.g. `~/.agents/skills/implement/`) is
  exactly as real a candidate as one committed to the repo, and is commonly
  where the best-fitting skill for a role actually lives. Glob both scopes,
  project first then the matching global/user directory:
  - native: `skills/*/SKILL.md`, `.omp/skills/*/SKILL.md` ↔ `~/.omp/agent/skills/*/SKILL.md`
  - claude: `.claude/skills/*/SKILL.md` ↔ `~/.claude/skills/*/SKILL.md`
  - agents: `.agent/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` ↔
    `~/.agent/skills/*/SKILL.md`, `~/.agents/skills/*/SKILL.md`
  Read each hit's frontmatter `description` to learn what it is for. A skill
  found this way is still a legitimate candidate even though it is not in
  your own catalogue — most of the best matches (a literally-named
  `implement`, `triage`, `research`, …) tend to live only globally, not in
  the repo. If step 3 turns up a plausible role with nothing to map it to,
  that is a signal this glob was skipped or scoped wrong, not that no skill
  exists — recheck before leaving the role out.

`disable-model-invocation: true` skills found either way still need the
`command:` prefix in step 5, same as any other skill.

## 3. Infer the roles this project probably wants

A role only earns a place in `roles:` if a *found* skill actually fits it —
this step never fabricates a skill name to fill a slot. Ground the mapping in
real signal from the repo, not a fixed checklist:

- Read `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` and any repo-rules files
  already loaded into your context for a documented house process (a required
  review step, a TDD mandate, a security pass) — that is the strongest signal
  for what a role name should be.
- For each of the five candidate names below, actively check the *full* set
  discovered in step 2 (session catalogue plus every project and global
  glob) for a skill that fits it — an exact or near-exact name match first,
  then a `description` match — before deciding none exists. Do not stop at
  skills that merely happened to surface first:
  `review` (code review before merge), `implement` (the house way of
  building a feature), `test` (a TDD or test-first convention),
  `security-review`, `design-review`. These are candidate names, not a
  mandatory list — map only the ones a discovered skill actually covers.
- Prefer an exact or near-exact conceptual match (a skill literally named
  `code-review` maps cleanly to `review`) over a loose guess. When nothing
  found fits a plausible role well, leave that role out rather than mapping it
  to something approximate.

## 4. Match roles to an existing model convention

A role's config value can carry a second, space-separated token pinning it to
a model or omp modelRole selector (`review: code-review @review`) — see
`foreman roles`/`skill://foreman-boss`. This step never invents a model; it
only proposes one when real signal already exists:

- `modelRoles:` can be set globally (`~/.omp/agent/config.yml`) or per-project
  (`<repo>/.omp/config.yml`, with `.omp/settings.json` as a legacy fallback);
  project entries override global ones key-for-key (see omp://settings.md,
  "Precedence"). Read both files' `modelRoles:` block — a key present in
  project wins over the same key in global, but a global-only key is still a
  real, already-made decision and still counts.
- When a role you are about to write (`review`, `implement`, …) exactly
  matches a `modelRoles` key found in either file, append that role's alias —
  `@<name>` — as the second token. That is a real, already-made decision
  ("review runs on the good model"), not a guess.
- Do not propose a model for a role with no matching `modelRoles` key in
  either file, and never invent a raw `provider/model-id` selector — this
  step only wires an alias that already exists, it does not pick models.
  Built-in role names (`default`, `smol`, `slow`, `task`, …) resolve even
  with nothing written to either file; a role only counts as "configured"
  when the key actually appears in one of the two files, not merely because
  `omp config get modelRoles.<name>` returns a value.
- Neither file has a `modelRoles` key at all: skip this step entirely and
  write plain skill-only role values, same as today.

## 5. Write it

Edit `.foreman/config.yml`'s `roles:` block directly with the mapping you
settled on, preserving any lines already there (a rerun must not clobber a
mapping the user already wrote by hand — merge in only roles that are still
absent). Uncomment the `roles:` key if the scaffold's example was still
commented out.

## 6. Report

Print the resulting mapping and, for each entry, the one-line reason it was
chosen (which repo signal or skill matched, and which `modelRoles` key
justified a model token, if any). Note that `.foreman/config.yml` is a normal
file in the checkout — it shows up in `git status`/`git diff` like any other
change, and is meant to be reviewed and committed like one. Point at
`foreman roles` to re-verify the mapping, and mention that entries can be
edited or removed by hand at any time; nothing else in foreman depends on
what this command chose beyond what is written in that file.

$ARGUMENTS
