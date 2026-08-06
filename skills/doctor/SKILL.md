---
name: doctor
description: Diagnosing and repairing drift in .omp/foreman.json against live GitHub state — renamed labels, moved/renamed board fields or options, stale detected commands, board hygiene, and a stale or wrong companion rule pack. Read when running /foreman:doctor, or when a foreman skill hits a resolution failure (missing label, unknown option ID, a detected command that 404s).
---

# Doctor — catch drift before it silently breaks tracking

`.omp/foreman.json` is a cache of things that live on GitHub (labels, a
project board's field/option IDs), in the repo (package manager, scripts,
commit types), and in omp's own plugin state (which rule packs this repo
decided it needs). All of those can change out from under it: a label gets
renamed, someone edits the board's `Status` options by hand, a script gets
renamed in `package.json`, the project switches package manager and the pack
guarding the old one keeps firing. This skill finds that drift and repairs
it — it's `bootstrap` run in verification mode instead of setup mode, and
it's what `/foreman:doctor` runs.

## What it checks

1. **Labels.** Every name in `labels.*` (the idea/epic/task/bug prefix,
   and each entry in `bugSeverities`) actually exists (`gh label list
   --json name`). Missing → recreate it (bootstrap §1) rather than
   silently continuing to file issues with a label that isn't there.
2. **Board identity.** `board.projectNodeId` still resolves (`gh project
   view <number> --owner <owner> --format json`). If the project was
   deleted or the number changed, stop and ask — don't recreate a board
   out from under existing issues.
3. **Status roles.** Re-fetch `gh project field-list <number> --owner
   <owner> --format json`, diff every `board.statuses.<role>.{name,id}`
   against live data:
   - A **name** change with the same `id` is cosmetic (someone renamed a
     column) — update the config silently.
   - An **id** that no longer exists is not cosmetic — someone edited the
     option list outright. Don't guess a replacement; flag it and point
     back at the recovery note in `bootstrap`'s Hazards (each issue's
     timeline keeps `ProjectV2ItemStatusChangedEvent`).
4. **Repo conventions.** Re-run the detection steps from `bootstrap` §3
   (main branch, commit types, package manager, check/verify/e2e
   commands). A detected value that no longer matches reality (a renamed
   script, a switched package manager, a new commitlint config) gets
   corrected. A value that doesn't match any detector's output but also
   isn't obviously stale (no dead script, no renamed lockfile) is left
   alone — report the mismatch as informational, don't overwrite what
   looks like a deliberate hand-edit.
5. **Board hygiene sweep** (the same checks as the `grooming` skill's
   stale-board section, runnable standalone): `inProgress` issues with no
   matching branch anywhere (`git ls-remote --heads origin` against
   `<issue>-` patterns); `review` issues whose PR is merged or closed;
   epics whose derived status (`tracker` skill) disagrees with the board.
6. **Rule packs.** Compare `plugins.packs` against what's actually installed
   at project scope (`omp plugin list`), and against what `bootstrap` §4 would
   conclude today:
   - A recorded pack that isn't installed → install it, or drop it from
     `plugins.packs` if the evidence for it is gone. Say which and why.
   - The **wrong package-manager pack** is the one that matters. A repo that
     migrated pnpm → bun keeps firing `pnpm-only` on every correct `bun
     install`, so the operator learns to dismiss rule interrupts — which
     silently disarms every other pack too. Uninstall the stale one
     (`omp plugin uninstall --scope project <pack>@omp-foreman`) and install
     the pack matching the re-detected `commands.packageManager`.
   - Two package-manager packs installed at once is always a bug, never a
     polyglot setup: they fire on each other. Resolve to one.
   - A conditional pack whose evidence disappeared (`generated-files` with no
     tracked generated file left) is informational, not urgent — report it and
     let the operator decide, since removing it costs a reinstall if the
     evidence comes back.

## Procedure

Read-only pass first: gather every finding above without writing anything.
Then present them as a table (check → current config value → live value
→ proposed fix) before applying anything. Apply only the unambiguous
repairs — a cosmetic rename, a re-detected command that still resolves to
a real script. Ask before touching anything ambiguous: a vanished option
`id`, a project that 404s, a config value that looks like a deliberate
hand-edit rather than staleness.

## Report

What was checked, what was clean, what was repaired (before → after), and
what needs a decision (with the specific question, not just "something's
off"). If everything is clean, say so in one line — a doctor run that
finds nothing is a successful outcome, not a wasted one.
