---
name: doctor
description: Diagnosing and repairing drift in .omp/foreman.json against live GitHub and repo state — renamed labels, moved/renamed board fields or options, stale detected commands, doc paths, workflow policy drift, board hygiene, and missing, stale, or wrong companion packs. Read when running /foreman:doctor, or when a foreman skill hits a resolution failure (missing label, unknown option ID, a dead doc path, a detected command that 404s, or a skill:// that resolves to nothing).
---

# Doctor — catch drift before it silently breaks tracking

`.omp/foreman.json` is a cache of things that live on GitHub (labels, a
project board's field/option IDs), in the repo (package manager, scripts,
commit types), in foreman's workflow policy (which mechanism and rigor the
project selected), and in omp's own plugin state (which rule packs this repo
decided it needs). All of those can change out from under it: a label gets
renamed, someone edits the board's `Status` options by hand, a script gets
renamed in `package.json`, the project switches package manager and the pack
guarding the old one keeps firing. This skill finds that drift and repairs
it — it's `bootstrap` run in verification mode instead of setup mode, and
it's what `/foreman:doctor` runs.

## What it checks

1. **Labels.** Every name in `labels.*` (the
   idea/epic/task/bug prefix, each entry in `bugSeverities`, and the
   `readyForHuman`/`chart` modifiers) actually exists (`gh label list
   --json name`). Missing → recreate it (bootstrap §1) rather than
   silently continuing to file or read issues with a label that
   isn't there.
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
   (main branch, commit types, the full lockfile inventory and the primary
   package manager it implies, check/verify/e2e commands). A detected value
   that no longer matches reality (a renamed script, a switched package
   manager, a new commitlint config) gets corrected. A value that doesn't
   match any detector's output but also isn't obviously stale (no dead
   script, no renamed lockfile) is left alone — report the mismatch as
   informational, don't overwrite what looks like a deliberate hand-edit.
5. **Workflow policy.** Validate `policy` before interpreting a loop:
   - A missing `policy` block, a missing member within it, or a top-level
     `epicLoop` is pre-policy config. Fill in every missing policy default
     and migrate `epicLoop.maxConcurrentTracks` into
     `policy.epicLoop.maxConcurrentTracks`, removing the top-level object.
     This is unambiguous drift; repair it without asking.
   - `policy.worktree.strategy` accepts `git`, `herdr`, `provided`, or a
     repo-relative `.md` path. A shipped name is valid only when
     `skills/worktree/strategies/<name>.md` exists; a path is valid only when
     it resolves from the repo. A dead value is a hard finding, not a silent
     downgrade to `git`: that downgrade would make the loop create worktrees
     a project deliberately configured away.
   - `policy.plan.planner` accepts `non-trivial`, `always`, or `never`.
     `policy.tdd.enforcement` accepts `required` or `encouraged`.
     `policy.qa.gate` accepts `required`, `advisory`, or `off`.
     `policy.delivery.prStrategy` accepts `stacked` or `sequential`.
     `policy.delivery.mergePolicy` accepts `operator` or `agent-on-green`.
     `policy.epicLoop.maxConcurrentTracks` accepts any positive integer.
     `policy.epicLoop.dispatch` accepts `subagent` or `fleet`.
     An unrecognized value in any key is a stop-and-ask finding, never a
     coercion to its default.
   - `herdr` with `herdr` absent from `PATH`, or with `HERDR_ENV` unset, is
     a real finding because that strategy cannot execute here — and the
     same holds for `policy.epicLoop.dispatch: fleet` with the `fleet`
     CLI absent from `PATH` or `HERDR_ENV` unset. Report it;
     do not rewrite the value, since the operator may simply be running
     doctor outside herdr.
   - Surface every valid non-default policy value in the report. It is not
     drift, but it is the fact an operator most needs to see — for example,
     that this project runs QA advisory and merges on green — and is otherwise
     invisible in a config file nobody re-reads.
6. **Board hygiene sweep** (the same checks as the `grooming` skill's
   stale-board section, runnable standalone): `inProgress` issues with no
   matching branch anywhere (`git ls-remote --heads origin` against
   `<issue>-` patterns); `review` issues whose PR is merged or closed;
   epics whose derived status (`tracker` skill) disagrees with the board.
7. **Rule packs.** Compare `plugins.packs` against what's actually installed
   at project scope (`omp plugin list`), and against what `bootstrap` §5 would
   conclude today:
   - A recorded pack that isn't installed → install it, or drop it from
     `plugins.packs` if the evidence for it is gone. Say which and why.
   - The **wrong Node package-manager pack** is the one that matters. A repo
     that migrated pnpm → bun keeps firing `pnpm-only` on every correct `bun
     install`, so the operator learns to dismiss rule interrupts — which
     silently disarms every other pack too. Uninstall the stale one
     (`omp plugin uninstall --scope project <pack>@omp-foreman`) and install
     the pack matching the re-detected `commands.packageManager`.
   - Two packs claiming the **same** ecosystem is always a bug: two of
     `npm`/`pnpm`/`yarn`/`bun`, or `uv` alongside `pip`. They fire on each
     other's correct commands. Resolve to the one the lockfile evidence
     names.
   - Packs from **different** ecosystems are not that case, and this is the
     easiest wrong repair to make. `bun` and `cargo` installed together in a
     repo that has both `bun.lock` and `Cargo.lock` is correct: `cargo`
     makes no claim about Node and never fires on a Bun command. Don't
     uninstall it for not matching `commands.packageManager` — that field
     names the primary manager, not the only permitted one. The test is
     evidence, not primacy: flag a pack only when the repo has nothing left
     that the pack speaks to.
   - A missing **`craft`** fails differently and worse than the stale
     package-manager case. The stale pack creates noise; a missing
     required pack creates silence — a `skill://` resolves to nothing,
     so the foreman skill that needed it proceeds without ever knowing
     it was there. This isn't recommendation drift; it's a broken
     install. Install it at project scope (`omp plugin install --scope
     project craft@omp-foreman`) and keep it in `plugins.packs`.
   - A conditional pack whose evidence disappeared (`generated-files` with no
     tracked generated file left) is informational, not urgent — report it and
     let the operator decide, since removing it costs a reinstall if the
     evidence comes back.
   - Report the evidence either way: for every package-manager pack, the
     lockfile or manifest that keeps it, or the absence that condemns it. A
     bare "remove `cargo`" is the finding an operator can't check.
8. **Domain doc paths.** Re-run bootstrap's domain-doc layout
   detection and compare each `docs.*` field with the repo:
   - A non-null path that no longer exists → set its field to `null`.
     The repo deleted that glossary, map, ADR directory, PRD directory,
     or out-of-scope directory, and that's allowed.
   - A null field whose conventional path now exists → fill it in,
     using bootstrap's ordered ADR probe and its `NNNN-`-prefixed
     markdown-file requirement, or its ordered PRD probe and its
     at-least-one-markdown-file requirement.
   Both are ordinary drift, not errors. Repair them without asking;
   closing known drift is the point of doctor.

## Procedure

Read-only pass first: gather every finding above without writing
anything. Then present them as a table (check → current config value
→ live value → proposed fix) before applying anything. Apply only the
unambiguous repairs — a cosmetic rename, a re-detected command that
still resolves to a real script, pre-policy migration, doc-path drift, or
installing the required `craft` pack. Ask before touching anything
ambiguous: a vanished option `id`, a project that 404s, a dead or
unrecognized policy value, or a config value that looks like a deliberate
hand-edit rather than staleness.

## Report

What was checked, what was clean, what was repaired (before → after), and
what needs a decision (with the specific question, not just "something's
off"). If everything is clean, say so in one line — a doctor run that
finds nothing is a successful outcome, not a wasted one.
