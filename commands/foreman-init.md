---
description: Interview the user and write .foreman/roles.json for this repo
argument-hint: [optional notes on the team/roles this project needs]
---

Read `skill://foreman-spawner` now if you haven't already this session — it
covers what a role's `description` and `brief` are each for, and the
append/extend rules `foreman_spawn` and `foreman_convene` apply on top of
a role.

Then set up `.foreman/roles.json` for this repo, together with the user:

$ARGUMENTS

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
