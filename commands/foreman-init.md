---
description: Interview the user and write .foreman/roles.json and .foreman/setup.json for this repo
argument-hint: [optional notes on the team/roles/setup this project needs]
---

Read `skill://foreman-spawner` now if you haven't already this session — it
covers what a role's `description` and `brief` are each for, and the
append/extend rules `foreman_spawn` and `foreman_convene` apply on top of
a role.

Set up two files for this repo, together with the user: `.foreman/roles.json`
(standing roles, part A) and `.foreman/setup.json` (per-worktree
setup/teardown commands, part B). Do both — a project worth configuring
roles for is also worth wiring bootstrap commands for, and both live in the
same interview.

$ARGUMENTS

# Part A — Roles

## 1. Look at what's already there

- If `.foreman/roles.json` exists, read it and call `foreman_roles` to show
  the user the current table before changing anything. Ask whether this run
  is adding roles, editing existing ones, or starting over — don't overwrite
  silently.
- Glob the repo's `skills/` directory (and any `skill://` names mentioned in
  its README or AGENTS.md) so the roles you propose can point at skills that
  actually exist here, instead of inventing plausible-sounding ones.
- Skim the README/package.json/docs enough to know what kind of project this
  is — a library, a service, an app with a release process, a monorepo —
  since that shapes which standing roles are worth having at all.

## 2. Propose roles, don't just ask an open question

Suggest from this common set, but only the ones that fit what you found in
step 1, and drop any that make no sense for this repo (e.g. no release role
for a repo with no versioned releases):

- **Product/project manager** (`pm`) — sprint planning, ticket triage,
  prioritization calls. Convened as a standing expert.
- **Release engineer** (`release`) — tagging, changelogs, version bumps,
  publishing. Convened as a standing expert.
- **Integration/QA engineer** (`qa` or `integration`) — smoke-testing after
  workers merge, cross-cutting regressions a single worker's branch wouldn't
  catch. Convened as a standing expert.
- **Security reviewer** (`security`) — auth, secrets, dependency, and
  permissions review before a risky change ships. Convened as a standing
  expert, or spawned per-review if the team prefers a branch with findings
  committed to it.
- **Docs writer** (`docs`) — keeping README/CHANGELOG/user-facing docs in
  sync with what workers ship. Works either way: convened as a standing
  expert, or spawned per doc pass onto its own branch.
- A recurring **worker task shape** with no standing counterpart — e.g. a
  team that spawns the same kind of bug-fix or dependency-bump worker
  often enough that its `skills`/`model` are worth naming once. These are
  `foreman_spawn`-only roles: still ask the user for a task-specific
  `brief` per spawn — it's appended after the role's own charter, not a
  replacement for it.

Present the shortlist with a one-line rationale each, and explicitly invite
the user to add a role you didn't think of, drop one that doesn't fit, or
merge two into one — this is a conversation, not a form to fill in silently.

## 3. For each role the user wants, pin down four things

- **`description`** — spawner-facing, third person, sharp enough that a
  *different* session's `foreman_roles` call can tell from this line alone
  whether an incoming request belongs to this role. Weak: "handles
  releases." Strong: "Owns tagging and publishing. Defer here for release
  cuts, changelogs, and version bumps."
- **`brief`** — child-facing, second person, the role's charter as its
  cold-start context. For a `foreman_spawn`-only role, note that the
  per-spawn task brief is appended after this, not a replacement for it.
- **`skills`** — zero or more `skill://` URIs from step 1, in the order they
  should load. Don't force a skill on a role that doesn't need one.
- **`model`** — optional; only ask if the user cares about overriding the
  default for this specific role (e.g. a cheaper model for routine triage).

Pick a short handle per `^[a-z][a-z0-9_-]{0,31}$` for each — reuse `pm`,
`release`, `qa`, `security`, `docs` from step 2 unless the user prefers
something else.

## 4. Write the file

Write `.foreman/roles.json` as a single JSON object mapping each handle to
`{description, brief, skills, model}` (omit `skills`/`model` only if truly
empty — prefer `[]`/`null` for anything at least one existing role in the
file already sets, for a consistent shape). Preserve any existing roles the
user didn't ask to change. Then call `foreman_roles` again and show the
user the resulting table as confirmation.

## 5. Close the loop

Remind the user that `.foreman/roles.json` is meant to be committed — it's
shared team config, not local state — and that `foreman_convene` will pick
up new roles immediately with no restart needed. Don't commit it yourself;
that's the user's call.

# Part B — Setup/teardown

`.foreman/setup.json` configures commands `foreman_spawn` runs in a sibling
pane right after a worker's worktree is created (`setup`), and commands
`foreman_reap` runs to completion in a sibling pane before removing it
(`teardown`). See `skill://foreman-spawner` and `docs/ARCHITECTURE.md` §3.10
if present in this repo for the exact mechanics; you don't need them to do
this part, only the shape: `{ "setup": string[], "teardown": string[] }`.

## 6. Look at what's already there, and what the project needs to boot

- If `.foreman/setup.json` exists, read it and show the user the current
  `setup`/`teardown` arrays before changing anything. Ask whether this run
  is adding commands, editing existing ones, or starting over.
- Detect the project's own bootstrap by what's actually in the repo — don't
  guess from the language alone:
  - **Lockfile → install command**: `package-lock.json` → `npm ci`;
    `pnpm-lock.yaml` → `pnpm install`; `yarn.lock` → `yarn install
    --frozen-lockfile`; `bun.lockb`/`bun.lock` → `bun install`;
    `Gemfile.lock` → `bundle install`; `poetry.lock` → `poetry install`;
    `uv.lock` → `uv sync`; `requirements.txt` (no poetry/uv lock) → `pip
    install -r requirements.txt`; `Cargo.lock` → `cargo build`; `go.sum` →
    `go mod download`.
  - **Toolchain pin → trust/install**: `.mise.toml` or `.tool-versions` →
    `mise install` (herdr's own worktree creation already runs `mise
    trust`, so don't duplicate that step here).
  - **Env template**: `.env.example` or `.env.sample` with no `.env` already
    git-ignored-and-copied by tooling → propose `cp .env.example .env` only
    if the project doesn't already handle this itself (check for a
    postinstall script or setup doc saying otherwise first).
  - **Local services**: `docker-compose.yml`/`compose.yaml` → `docker
    compose up -d` as a `setup` candidate, `docker compose down` as the
    matching `teardown` — propose these as a pair or not at all, never one
    without the other.
  - **Database migrations**: a `migrate`/`db:setup` script in `package.json`
    or a `Makefile`/`justfile` target with a name like that → propose it as
    a `setup` command after the install step.
  - Skim `package.json` scripts, `Makefile`, and `justfile` for anything
    named `setup`, `bootstrap`, `dev:setup`, or similar — a project that
    already has one command for this is a stronger signal than composing
    several yourself; propose that single command instead of the pieces it
    wraps.
- If nothing in the repo needs setup beyond what herdr's own worktree
  creation already does (env file copying, `mise trust`), say so plainly
  and propose an empty `.foreman/setup.json` — or none at all — rather than
  inventing commands the project doesn't need.

## 7. Propose, don't just write

Present the detected `setup` and `teardown` commands as a shortlist with a
one-line reason each (what file or script triggered the suggestion), and
ask the user to confirm, drop, reorder, or add to it — the same
conversational posture as the roles shortlist in Part A. Commands run in
the order given, joined with `&&`, so ask about ordering when it matters
(e.g. install before migrate).

## 8. Write the file

Write `.foreman/setup.json` as `{ "setup": [...], "teardown": [...] }`,
omitting a key only if the user wants no commands for that phase (prefer
`[]` over omitting it, matching the shape `loadSetupConfig` expects).
Preserve any existing commands the user didn't ask to change.

## 9. Close the loop

Remind the user that both `.foreman/roles.json` and `.foreman/setup.json`
are meant to be committed — shared team config, not local state — and that
`foreman_spawn`/`foreman_reap`/`foreman_convene` pick up changes to either
immediately, no restart needed. Mention that `setup` runs in a pane
alongside the worker rather than blocking it, and a failed or slow `setup`
never blocks the spawn — it only shows up in the spawn result text and the
pane itself. Don't commit either file yourself; that's the user's call.
