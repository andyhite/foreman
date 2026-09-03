# Foreman — Build Specification

An omp-native plugin that runs a single-operator agile SDLC over Linear.

**Harness:** omp (oh-my-pi), installed as a project-scoped plugin, once per
repo, by `foreman init`.
**Substrate:** Linear (Triage inbox enabled), git worktrees, GitHub PRs.
**Scope:** the operator's personal projects. Single Linear org, single credential
set, no multi-tenant concerns.
**Operator:** one human running many concurrent agent tasks.

---

## 1. Purpose

Port the useful parts of agile process onto a single-operator agent fleet. The
useful parts are *artifact transitions* and *batched human decisions*. The
useless parts are ceremonies that exist to synchronize humans who don't share
context — there is only one human here, so those are dropped.

Foreman optimizes for one thing above all: **minimizing the number of times the
operator is interrupted.** Throughput is secondary. An agent that finishes
faster but asks three questions is worse than one that takes twice as long and
asks zero.

---

## 2. Design principles (invariants)

1. **Agents are named after transitions, not job titles.** An agent moves an
   issue exactly one state to the right and stops.
2. **Agents never block on interactive input.** omp subagents run headlessly and
   *cannot* pause for approval — `tools.approvalMode` is forced to `yolo` for
   child sessions. This is not a policy choice; it is the runtime. See §9.
3. **Every agent returns a validated structured artifact**, not prose to be
   parsed. Frontmatter `output` + `schemaMode: strict` (§6).
4. **Gates are machine-checkable predicates** over that structured output.
5. **Enforce in frontmatter and code, not in prose.** Tool allowlists, `spawns`,
   and output schemas are enforced by the harness. A constraint that exists only
   as a sentence in a system prompt is a suggestion.
6. **Bulk mutation is still gated.** `foreman-triage`'s output is applied
   directly by the extension (§7.1) — there is no separate operator-approved
   proposal step — but every write still goes through gate validators and a
   `Confirmer` (§17.9), so nothing lands unchecked.
7. **Review runs in a cold context.** Child sessions do not inherit conversation
   history — structurally guaranteed. Don't defeat it by passing implementation
   rationale through `context`.
8. **Prefer native primitives.** Linear fields over labels; omp's budgets,
   registry, and lifecycle over custom equivalents.
9. **The extension is the sole Linear writer.** Agents hold read tools only;
   every mutation is applied by the extension from a validated structured
   result. One write path, one blast radius, and "propose, validate, apply"
   becomes structural rather than policy.

---

## 3. omp plugin architecture

### 3.1 Package shape

Foreman is three consumers over one shared core. Keep it a small monorepo so the
Linear client, output schemas, and gate validators exist exactly once —
duplicating validators between the extension and the loop is how the workers and
the agents start disagreeing about whether an issue is ready.

```
foreman/
  packages/
    core/                       # Linear client, schemas, gate validators
    omp-plugin/                 # below — installed project-scoped per repo, never user-wide
    loop/                       # `foreman build` / `plan` / `reconcile` CLIs (§17)
```

The omp plugin is a Claude/OMP-compatible plugin directory. It is **activated
project-scoped**, into the specific repo `foreman init` registers — never
user-scoped. A user-scoped install would put Foreman's agents, skills, TTSR
rules, and slash commands into every omp session on the machine, including
repos that never use Foreman; Foreman is per-repo by construction — the
`repos` registry (§3.10) binds specific repos — so machine-wide is never the
right scope. It is also the only scope omp's own CLI can reach: `--scope` is
honored for a marketplace install (`name@marketplace`) alone, while `omp
plugin link <dir>` and installs from a local path are unconditionally
user-wide regardless of any flag passed — verified against omp 18.1.4: `omp
plugin link <dir> --scope project` reports success, writes nothing to the
project, and adds a *user*-scope entry to `~/.omp/plugins/omp-plugins.lock.json`,
the exact machine-wide leak this design exists to avoid.

That is why activation is a direct filesystem write rather than an `omp
plugin` call. A project plugin root is three things, and omp discovers a
plugin from them with no marketplace, cache, or network involved — verified
against omp 18.1.4 by probing a scratch repo over ACP:

```
<repo>/.omp/plugins/omp-plugins.lock.json
<repo>/.omp/plugins/installed_plugins.json
<repo>/.omp/plugins/node_modules/@foreman/omp-plugin -> <plugin dir>
```

The lock file makes the extension module, skills, rules, hooks, and tools
load, and `commands/*.md` register under a bare file stem (`/refine`, not
`/foreman:refine`) — omp's `omp-plugins` provider never namespaces a
command by plugin. `installed_plugins.json` is a second, Claude-Code-shaped
registry, keyed `"foreman@foreman"`, that only omp's `claude-plugins`
provider reads; that provider is the one that prefixes a command with its
plugin id, so this is what makes `/foreman:refine` (DISPATCH_COMMAND,
§17.4) resolve to a real command instead of falling through as unexpanded
literal text. Once `installed_plugins.json` names the same plugin realpath
as the lock file, `listOmpExtensionRoots` excludes it from the `omp-plugins`
provider's own root list to avoid double registration (verified against omp
18.1.5: skills/rules/commands all then load exactly once, tagged
`[claude-plugins]` by `omp ttsr list` and the ACP `available_commands_update`
notification) — the extension module itself is unaffected, since it loads
through the lock file directly rather than through that root list.

`foreman init` writes all three of those, plus a `/.omp/plugins/` line
in `.git/info/exclude` so the machine-local root never shows up in `git
status`. `foreman deinit` is the exact inverse. Neither runs an `omp`
subprocess, touches the network, or clones anything.

The per-repo symlink does not target the checkout directly; it targets one
stable indirection, `~/.foreman/plugin`, written once by `foreman setup`.
omp resolves symlink chains, so repo → `~/.foreman/plugin` → checkout loads
identically to a direct link, and re-pointing that one global link — at a
fresh clone, a relocated checkout, or (for Foreman's own development) the
working tree itself — updates every registered repo at once with no
per-repo re-install and no separate "dev mode" install shape to drift from
the real one. `packages/cli/src/plugin-activation.ts` owns both the global
link and the per-repo activation; its header comment carries the full
rationale above. `/reload-plugins` applies Markdown changes (agents, skills,
commands, rules) without a restart either way; a changed extension needs
`bun run build`.

**`foreman update` — the machine-refresh contract.** After Foreman changes
land on GitHub, `foreman update` is the only supported way to bring a
machine current; a hand-rolled `git pull` alone is not equivalent and MUST
NOT be recommended in its place, because the installed `foreman` command is
a symlink to `packages/cli/dist/main.js` and a pull without a rebuild leaves
the operator running the previous build under the new source. It runs, in
order: (1) pull the Foreman checkout (`git pull --ff-only`, skippable with
`--skip-pull`); (2) rebuild it (`bun install && bun run build`); (3)
re-assert the global plugin link at `~/.foreman/plugin`, self-healing it if
it was moved or clobbered since `foreman setup` ran; (4) walk every repo in
the `repos` registry (§3.10) and repair activation drift — a repo whose
link or lock entry has gone stale is re-activated, a healthy repo is left
untouched and reported as such — skippable entirely with `--skip-plugin`.
There is **no per-repo install step**: every repo's plugin symlink resolves
through `~/.foreman/plugin` to this checkout, so step 2 alone updates every
registered repo at once. The version-keyed shared-cache hazard the previous
marketplace-based install carried — upgrading one repo past a version bump
silently deleting the cache directory every other repo's symlink pointed
at, stranding them — does not exist in this design; there is no shared,
version-keyed cache left to strand anything in.

**The full command surface** is five installer commands with disjoint
scope, because the machine, a repo, and the source checkout are three
independently mutable things:

| Command | Scope | Flags |
| --- | --- | --- |
| `foreman setup` | per-machine: tool preflight, the Linear credential, the one global plugin link at `~/.foreman/plugin` | `--link` (dev mode: run from this checkout's source, no rebuild to see changes), `--checkout <path>`, `--skip-linear` |
| `foreman init` | per-repo: one `repos` entry, plus the two files that activate the plugin in that repo | `--path <dir>`, `--initiative <id>` (repeatable), `--alias <name>`, `--team <KEY>`, `--skip-plugin`, `--skip-linear` |
| `foreman deinit` | per-repo: the exact inverse of `init` | `--path <dir>`, `--keep-registry` (deactivate the plugin but leave the `repos` entry in place) |
| `foreman verify` | verification and repair for both layers | `--fix`, `--checkout <path>` |
| `foreman update` | pull, rebuild, then repair drift | `--checkout <path>`, `--skip-pull`, `--skip-plugin` |

All five also accept `-y`/`--yes` (accept defaults for every prompt,
non-interactive), `--home <path>` (home directory for `~/.foreman`; a test
hook), and `--help`/`-h`. There is no `--repo-source` flag; the plugin has
exactly one distribution path, the global link, so there is nothing left to
choose a source for.

Everything below `packages/omp-plugin/` except `package.json` and `src/` is
*auto-discovered by convention*: omp scans an installed plugin tree for
`agents/`, `commands/`, `skills/`, `rules/`, `prompts/`, `hooks/`, `tools/`,
and `.mcp.json` with no manifest entry naming any of them. Only the extension
module has to be declared.

```
packages/omp-plugin/
  package.json                  # omp.extensions declaration — the ONLY declared path
  agents/                       # auto-discovered (§3.2)
    foreman-triage.md  foreman-refine.md  foreman-plan.md  foreman-roadmap.md
    foreman-implement.md  foreman-review.md
  skills/                       # auto-discovered (§3.3); dir name is the skill name
    foreman-triage-inbox/SKILL.md   foreman-refine-issue/SKILL.md
    foreman-plan-project/SKILL.md   foreman-plan-roadmap/SKILL.md
    foreman-implement-issue/SKILL.md
    foreman-review-diff/SKILL.md    foreman-spike/SKILL.md
    foreman-block-protocol/SKILL.md
  commands/                     # auto-discovered; one per agent dispatch, `$1`-substituted
    triage.md  refine.md  plan.md  roadmap.md  implement.md  review.md
  rules/                        # auto-discovered (§15)
    foreman-no-interactive-questions.md
    foreman-no-scope-expansion.md
    foreman-no-gate-bypass.md
    foreman-no-merge.md
  schemas/                      # JSON Schema for each agent's output (§6)
  scripts/check-contract.ts     # the enforcement-surface guard (§3.13)
  src/
    extension.ts                # the declared entrypoint's source
    tools/                      # foreman_linear_read, foreman_github_pr
    render/                     # Linear comment and issue-body rendering (§3.1.1)
    enforce/  results/  commands/  runtime.ts
```

`@foreman/core` carries the matching guard for the other fabricable surface:
`scripts/validate-linear-schema.ts` (`bun run schema:linear`) checks every
document in `src/linear/queries.ts` against Linear's schema, fetched by
introspection. It is not part of `bun run check` because it needs a live
credential and `check` runs offline, but it is the only thing that can catch
a field name Linear does not have: a fake answers whatever shape it is asked
for, so `Team.workflowStates` passed the whole suite while failing every real
call (§16). Run it after touching a query.

`/foreman:status`, `/foreman:merge`, and `/foreman:unblock`
are `pi.registerCommand` calls in `src/`, not files in `commands/` — they run
code rather than expanding a prompt. Both tools are likewise registered by the
extension rather than dropped in `tools/`, because each one closes over the
lazily-initialized runtime (`getLinear()`, `getEntry()`) that `session_start`
builds; an auto-discovered `tools/` module is a separate module graph and would
not share that state.

**Manifest footgun:** the omp key for extension modules is `omp.extensions` (an
array), not `omp.hooks`. Resolution is `pkg.omp` first with fallback to
`pkg.pi`; declaring the wrong key means the extension silently never loads and
nothing warns you. There is a public bug trail on exactly this.

**The plugin has no build step and no artifact.** `omp.extensions` names
`./src/extension.ts` directly, and omp loads TypeScript straight from the
checkout rather than a built `dist/`. Verified against omp 18.1.4: loading
the plugin over ACP from a repo with `dist/` deleted, all three extension
commands (`foreman:status|merge|unblock`) and all eight skills loaded,
and end-to-end session startup was indistinguishable from the old bundled
entrypoint (medians 6.53s source vs 6.75s bundled, run-to-run variance
5.0–7.0s). This retires the whole failure class rather than guarding it:
there is no artifact to go stale, to be forgotten to build, or to ship
missing.

The one condition that would bring a build back is shipping the plugin to a
machine with no checkout — a copied-directory install runs no package
manager, so a source entrypoint would have no `node_modules`. SPEC's
non-goals already exclude any such distribution channel.

**TypeBox still has to go through a chokepoint, and that chokepoint is now
the whole mechanism.** omp rewrites the *bare* `@sinclair/typebox` specifier
to its `@oh-my-pi/omptype` facade, which rejects `default: {}` (throwing "A
mutable default value must be specified as a factory") and returns opaque
validators with no `.properties` that `JSON.stringify` throws on —
`config/schema.ts` carries eleven `default: {}` uses that would break under
it. The filter only matches the bare specifier and `typebox`, so the
subpaths `@sinclair/typebox/type` and `/value` reach real TypeBox untouched.
Core imports exclusively through `packages/core/src/typebox.ts`, which uses
those un-remapped subpaths; `packages/core/test/typebox-import.test.ts`
enforces that nothing in core reaches the bare specifier instead.

**Core must not adopt omp's TypeBox**, which is otherwise the obvious
simplification. `packages/cli` ships the standalone `foreman` binary, depends
on core, and has no omp dependency — `foreman init` is what installs the omp
plugin in the first place, so it necessarily runs before omp's runtime exists
in a repo. Routing core's schemas through `@oh-my-pi/omptype` would make the
tool that bootstraps omp depend on omp's internals to read
`~/.foreman/config.json`. `pi.zod`, `pi.arktype`, and `pi.typebox` are also
injected members of the `pi` object, not importable modules — they exist
only inside a live extension, while core also runs in the standalone CLI and
the loop, neither of which has a `pi` to inject from. The two libraries
additionally disagree on semantics that §3.10's sparse-override design rests
on: omptype validates a default as an instance of its schema, while TypeBox
treats `default` as inert annotation that `Value.Default` later applies.

```json
{
  "omp": {
    "name": "foreman",
    "description": "Agile SDLC workflow over Linear",
    "extensions": ["./src/extension.ts"]
  }
}
```

Plugin names: lowercase alphanumeric, hyphens and dots, start and end
alphanumeric, ≤64 chars. `foreman` is valid; underscores and capitals are not.

#### 3.1.1 What `@foreman/core` is for

Core exists because two independent writers mutate the same Linear workspace:
the omp plugin (operator commands and agent dispatches) and the loop CLIs
(autonomous, §17). A duplicated filter or label constant means the two
disagree about whether an issue is Ready, and both claim it. Core is that
shared state contract, not a general utility bin.

Measured against the actual import graph — 103 distinct core identifiers
imported by `omp-plugin`, 100 by `loop`, 15 by `cli`, with 45 used by both the
plugin and the loop:

| Module | Shared by plugin + loop | Contract it protects |
| --- | --- | --- |
| `linear/` | 9 | saved-view filters and the API client |
| `config/` | 8 (all three packages) | `~/.foreman/config.json` semantics |
| `domain/` | 7 | label, priority, and state vocabulary |
| `markers/` | 4 | comment-marker encoding for lock/dispatch/merge records |
| `schemas/` `apply/` `lock/` | 9 | agent output contracts and the lock protocol |

A `control/` directory used to sit here too, backing a unix-socket wire
protocol between the loop and the plugin. It has no replacement and no
successor module: the loop simplification deleted the control plane outright
(there is no live-process introspection surface; `/foreman:status` reads
Linear directly) rather than moving it anywhere.

Two directories used to sit in core without a shared consumer and have been
moved out. Neither belongs back:

- `dispatch/herdr.ts` and `dispatch/print.ts` (795 lines) had zero plugin and
  zero CLI imports and now live in `packages/loop/src/dispatch/`. Only
  `dispatch/types.ts` stays in core, because `apply/cleanup.ts` takes a
  type-only `Dispatcher`. The plugin bundle shrank 15 KB on the move: it had
  been inlining both dispatcher implementations it never called.
- `render/` (444 lines) was imported by the plugin alone and by nothing inside
  core; it now lives in `packages/omp-plugin/src/render/`.

`renderPrBody` survived the move with no production caller — it is exercised
only by `packages/omp-plugin/test/render.test.ts`. The implement agent writes
its own PR body through `foreman_github_pr`, so either that helper is dead or
the agent should be using it; resolve the question rather than leaving it.

`index.ts` re-exports every module with `export *`, which makes all 349 names
public while 182 of them are imported by no consumer. That flat barrel is also
why importing a single label constant evaluates `config/schema.ts` — the
failure mode recorded in docs/VERIFIED.md. Prefer narrowing the barrel over
adding to it.

### 3.2 Agent discovery precedence

First-wins by **exact, case-sensitive** name (`Reviewer` and `reviewer` are
distinct):

1. Project `.omp/agents/<name>.md`
2. User `~/.omp/agent/agents/<name>.md`
3. Plugin `agents/<name>.md` ← **Foreman lives here**
4. Claude marketplace plugin agents
5. Bundled

Only `.omp` roots are scanned; `.claude/agents/`, `.codex/agents/`, and
`.gemini/agents/` are skipped because their frontmatter schema differs.

Prefix every agent `foreman-`. The bundled roster differs between doc versions
(one lists `scout`/`sonic`/`security-reviewer`, another lists
`explore`/`plan`/`oracle`/`quick_task`), but `reviewer` and `designer` appear in
both — an agent named `reviewer` would shadow the bundled one globally, not just
inside Foreman.

### 3.3 Skill discovery

Plugin `skills/` are picked up by the `omp-plugins` provider at priority 90, well
above auto-learn managed skills (priority 5). Dedup key is skill name,
first-wins. Prefix skill names too, or accept that a same-named user skill
silently shadows Foreman's.

### 3.4 Commands (prompt templates)

Markdown files with YAML frontmatter, invoked as slash commands. The body is a
prompt template injected as a user message with arguments interpolated — so each
command is literally "dispatch `<agent>` against `<target>` with this context,"
which is the explicit kickoff surface for every step.

| Command | Dispatches | Argument |
|---|---|---|
| `/foreman:triage` | `foreman-triage` over the Inbox view, batched up to `loop.triageBatch` (§3.10) | none |
| `/foreman:refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman:plan` | `foreman-plan` — turns a bare project's brief into its first slate of issues | `<PROJECT-ID>` |
| `/foreman:roadmap` | `foreman-roadmap` — decomposes an initiative's brief into its next slate of projects | `<INITIATIVE-ID>` |
| `/foreman:implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` | `<ISSUE-ID>` or PR |
| `/foreman:merge` | no agent — the extension merges via the configured strategy once the review gate passes (§10) | `<ISSUE-ID>` |
| `/foreman:unblock` | no agent — records the operator's reply, clears `foreman:blocked`, and returns the issue to Todo (§9) | `<ISSUE-ID>` |
| `/foreman:status` | no agent — renders the operator console | none |

Each dispatch command body must: resolve the target issue, assemble the shared
`context` (the two-layer Context digest per §4.7 + the issue), state the agent to spawn,
and state the gate that must hold. It must **not** restate the procedure — that
lives in the autoloaded skill (§8). A command that duplicates its skill will
drift from it.

**These commands are also the loop's dispatch surface** (§17). The scheduler
shells the same command the operator types, via print mode. One code path,
so manual and automatic runs cannot diverge.

`/foreman:status` is the in-chat operator console: blocked queue, in-flight
locks, proposals awaiting approval, live agent registry, and loop state. Build
it early — it is how the interrupt-batching model gets used, and it remains
the fallback when herdr isn't running.

### 3.5 Extension module

`src/extension.ts` registers via the `pi.on(...)` event bus and owns everything
that must be real code:

1. **Typed Linear tools.** Ship first-class read tools (TypeBox schemas) rather
   than routing through generic MCP — `foreman_linear_read` is what agents get.
   The write client exists only *inside* the extension and is never exposed as
   an agent tool (principle 9). This is stronger than a read/write tool split:
   there is no allowlist mistake that can hand an agent write access, because
   no write tool exists to grant.
   Both tools register with `loadMode: "essential"`. That is load-bearing, not
   cosmetic: an extension tool defaults to `discoverable`, which omp's
   `tools.xdev` layer demotes into an `xd://` device — invisible under the bare
   name every command, agent, and skill uses (docs/VERIFIED.md). The contract
   check fails on any registration that is not `essential`.
2. **Gate validators.** Pure functions over a Linear issue returning
   pass/fail + reason, consumed by agents, commands, and pre-hooks alike. One
   implementation, never reimplemented in prose inside a skill.
3. **Lock manager.** Writes `foreman:running` + dispatch ID + timestamp before
   every spawn and releases it after the yield is consumed. Agents never touch
   the lock (§11).
4. **Orphan-lock recovery** on `session_start` — the reconcile pass's
   successor to a background reaper (§11, §17.6).
5. **Structured-output consumers.** Read `structuredOutput.data` off each
   `SingleResult` and drive every Linear mutation from validated objects —
   descriptions, labels, state moves, sub-issue and spike creation, discovered
   work, comments, review renderings. This is where principle 9 lives.
   The `SingleResult` arrives on exactly one channel — the `task` tool's
   `tool_result`, whose `structuredOutput` is `{ source, mode, status, data }`
   (docs/VERIFIED.md) — and only for a synchronous spawn. Every workflow
   agent therefore declares `blocking: true`: a background spawn's result is
   delivered as an `async-result` message carrying no structured data at all,
   so there is nothing to apply and the yield is lost.
6. **Config loader.** Reads and validates the global `~/.foreman/config.json`
   (§3.10) — including the `repos` registry: each entry's path, `team`, and
   bound `initiatives` (**IDs**, not names — grouping prefixes rename), per
   the instance model (§3.11). The instance's own entry is resolved by
   matching cwd against registry paths. Scope check: issue → project → its
   single product initiative (§4.0) → must be in this entry's bound set — the
   loop skips misses, manual commands refuse with the reason. Validated on
   `session_start` alongside the skill-name guard (§8) — including the
   cross-repo initiative-uniqueness check (§3.10) — and the ensure pass
   (§3.11) runs here too; an invalid config or unresolvable scope fails
   loudly before any spawn. Per-project overrides are deliberately absent —
   nothing needs one today, and the chain makes adding it a five-line change
   when something does.
7. **Subagent lifecycle listeners.** `task:subagent:lifecycle`,
   `task:subagent:progress`, and `task:subagent:event` fire on the parent bus.
   Use them to keep `/foreman:status` live and to detect aborts — and only
   for that: their payloads carry status alone (no task text, no
   `structuredOutput`), so they are not a second capture channel for item 5
   (docs/VERIFIED.md).
8. **GitHub read client.** Extension-internal, like the Linear write client:
   fetches PR diffs and head SHAs for review dispatch (§7.4) and checks CI
   status for the review gate (§10). Never exposed as an agent tool.

### 3.6 Budgets — use the native ones

omp already implements everything §3.5 would otherwise hand-roll. Configure
rather than reimplement:

| Setting | Default | Foreman use |
|---|---|---|
| `task.softRequestBudget` | 200 requests | Per-agent ceiling. Crossing it injects a wrap-up notice; at 1.5× the run is force-stopped and yields partial findings. |
| `task.maxRuntimeMs` | 0 (off) | **Set it — 2 h.** An implement agent that runs six hours is stuck, not thorough. The lock TTL derives from this (§11). |
| `task.agentIdleTtlMs` | 420 000 (7 min) | Idle agents park after this; `hub` messaging revives them (§9). |
| `task.maxRecursionDepth` | — | Irrelevant once `spawns: false` (§5). |

A soft-budget abort on a non-isolated kept-alive agent is treated as
**resumable**: the agent goes `idle` and can take a follow-up. That is the
behavior Foreman wants on budget exhaustion — pair it with a block record (§9).

### 3.7 Isolation — do not use `isolated: true` for implement

This corrects the obvious first instinct. omp's task isolation tears the
workspace down at completion, and **isolated agents are parked without a reviver
— not revivable**. Two hard conflicts with Foreman:

- The block protocol requires the worktree to survive so the operator can
  inspect it and a resume can continue from it. Isolation deletes it.
- Branch merge mode commits to `omp/task/<id>` and cherry-picks into the parent,
  which collides with Foreman's `<issue-id>-<slug>` branch convention. Patch
  mode avoids the naming collision but still tears down.

**Therefore:** `foreman-implement` runs **non-isolated** in a Foreman-managed
worktree created by the extension before the spawn. Foreman owns worktree
lifecycle; omp owns session lifecycle.

Isolation mode names have also changed — current values are `none`, `auto`,
`apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`,
`rcopy`. `worktree`, `fuse-overlay`, and `fuse-projfs` are accepted only for
back-compat. If a future Foreman agent does want isolation, use `auto` and let
the PAL resolve with fallback.

### 3.8 Scheduling

omp has no built-in scheduler and Foreman needs none: `foreman plan` and
`foreman build` are long-running loop processes (§17), not periodic jobs. Run
each as a `launchd`/`systemd` unit, or in a `herdr` pane (§17.2), with
`restart: always`; there is no cron-triggered one-shot mode to reach for.

### 3.9 Hindsight memory — decide explicitly

omp extracts durable facts per project into `~/.omp/agent/memories/` and injects
a summary at session start. Foreman makes Linear the single source of truth for
project state. A stale memorized "decision" can contradict the current `Context`
doc with no way for the agent to know which is authoritative. Recommend
disabling autonomous memory for Foreman-managed repos so one source of truth is
actually one.

### 3.10 Configuration — `~/.foreman/config.json`

Everything that is a *parameter* rather than an *invariant* lives in **one
global config file**, loaded and schema-validated by `core` (TypeBox — the
same machinery as the output schemas) and consumed by all three consumers. No
per-repo config files: the `repos` registry inside the global file is the
single table binding repos to teams and initiatives, which gives both
consumers the same lookup — a loop instance resolves its scope from it by
cwd. Per-repo settings deep-merge over `repoDefaults`, entry wins — sparse
overrides only (`RepoSettingsOverrideSchema`), distinguishable from "inherit
the default" only by being absent, which is why `Value.Default` is never
called on the `repos` record directly (§3.1.1). `foreman init`, run once per
repo inside that repo, is the command that produces one `repos` entry **and**
installs the omp plugin project-scoped into that repo (§3.1); `foreman setup`
never touches this table — it writes the single global plugin link at
`~/.foreman/plugin` and nothing repo-specific.

The registry key is named `repos`, not `projects` — in this document
"project" means a Linear milestone (§4.1), and overloading it for repo
entries would guarantee confusion.

Sketch (defaults shown; every number quoted elsewhere in this spec is a
default defined here, not a constant — `packages/core/src/config/schema.ts`
is the source of truth):

```jsonc
{
  "loop": {
    "mode": "confirm",                                    // §17.9 — ask before every dispatch and every Linear write; "yolo" acts unattended
    "pollSeconds": 20,                                     // §17.1 — full-snapshot poll interval for `foreman plan`/`foreman build`
    "concurrency": { "plan": 1, "build": 3 },              // §17.1 — per-loop in-flight cap
    "triageBatch": 10,                                     // §17.1, §17.5 — max inbox issues one triage dispatch batches
    "stateDir": "~/.foreman/state",                        // §17.4 — process lock + in-flight bookkeeping
    "cleanupMergedWorktrees": true,                        // §12 — remove a merged issue's worktree once reconcile moves it to Done
    "autoMerge": false,                                    // §17.5 — let `foreman build` dispatch `/foreman:merge`; off by default, merge authority stays with the operator
    "retryCap": 2,                                         // §17.7 — failed dispatches for one unit of work before escalation to `foreman:blocked`
    "reviewCycleCap": 2                                    // §7.4, §17.7 — `request-changes` reviews on one issue before escalation
  },

  "linear": {
    "apiKeyEnv": "LINEAR_API_KEY",                        // checked first
    "apiKeyFile": null,                                   // checked when the env var is unset
    "endpoint": "https://api.linear.app/graphql",
    "allowCustomEndpoint": false,                          // required to point endpoint anywhere but api.linear.app
    "operatorUserId": null                                 // §9 Case B — Linear user id a block is assigned to; null skips assignee routing
  },

  "githubApp": {                                           // §7.4 — optional; null/null leaves reviews Linear-comment-only
    "appId": null,
    "privateKeyFile": null
  },

  "agent": {
    "maxRuntimeMs": 7200000,                              // §11 — mirrors omp's own task.maxRuntimeMs; the lock TTL derives from this
    "lockTtlMarginMs": 1800000,                           // lock TTL is 2 × maxRuntimeMs + this (~4.5h by default)
    "ompBin": "omp",
    "approvalMode": "yolo",                               // always-ask | write | yolo, passed to every dispatched parent session
    "herdrBin": "herdr",
    "dispatcher": "auto"                                   // §17.2 — auto | print | herdr; "auto" prefers herdr when reachable, else print
  },

  "repoDefaults": {                                       // inherited by every repos.* entry
    "baseBranch": "main",
    "pr": { "required": true, "draft": false, "ciRequired": true },
    "merge": { "strategy": "squash",                      // merge | squash | rebase
               "deleteBranch": true },
    "branchPattern": "<issue-id>-<slug>",                 // §12
    "worktreePattern": "../<repo>-<ISSUE-ID>"             // §12
  },

  "repos": {                                              // the registry (§3.11) — every Foreman-managed repo
    "plotroom": {                                         // alias: positional arg to `foreman build`/`plan`, state-dir segment
      "path": "~/Code/plotroom",
      "team": "PLT",                                      // optional if unambiguous
      "initiatives": [                                    // one or more; monorepos list several
        "<initiative-id>",
        { "id": "<initiative-id>", "path": "apps/zero" }  // optional path hint, fed to context assembly and implement's initial reads
      ]
      // plus any repoDefaults override, e.g. "pr": { "required": false }
    }
  }
}
```

Registry validation: an initiative bound in two `repos` entries is a config
error caught at load, not a runtime surprise.

**`pr.required: false` — direct-branch mode.** The workflow shape is unchanged
(one issue → one worktree → one branch), but implement pushes the branch and
opens no PR (`prUrl` stays empty in the `ImplementResult`), review diffs
`baseBranch..head` fetched by the extension (§7.4), the review gate targets the
pushed branch (§10), and Done cannot come from Linear's GitHub PR
integration — the `merged-not-done` reconcile invariant (§17.6) is what moves
the issue to Done in this mode, by resolving the latest push against
`baseBranch` when no PR exists (`GitHubClient.mergeBranchLocally`/local merge
check).

**`/foreman:merge <ISSUE-ID>` and `loop.autoMerge`.** Operator-invoked merge
never weakens the no-unattended-merge default (§19): `loop.autoMerge` is
`false` out of the box, so `foreman build`'s merge rule never fires unless
the operator turns it on, and even then it only offers a candidate once the
review gate — same validator both paths call — passes. `/foreman:merge`
checks the same gate, then merges with the configured strategy (`gh pr
merge` in PR mode, a local merge of the branch onto `baseBranch` in direct
mode) and deletes the branch if configured.

**Config tunes parameters, never removes invariants.** There is no key that
disables a gate, the lock protocol, or the review gate the merge rule and
`/foreman:merge` both call. Validation rejects unknown keys — a typo that
silently falls back to a default is the config-file equivalent of the
`autoload-skills` silent-ignore trap (§8).

Reload semantics: the extension reads config at `session_start`; `foreman
plan`/`foreman build` re-read at the top of every poll (§17.1), so tuning a
loop setting does not require a process restart.

### 3.11 Instance model — one loop pair per repo

Foreman runs **in a repo, for that repo's initiatives**. There is no central
daemon watching all of Linear; the unit of deployment is two long-running
processes per repo — `foreman plan <alias>` and `foreman build <alias>`
(§17.1) — each scoped to a team plus the initiatives bound to that repo in
the global `repos` registry (§3.10). A monorepo binds several initiatives —
the `plotroom` entry binds `Plotroom Fleet` and `Plotroom Zero`.

**Invocation.** `foreman plan <alias>` / `foreman build <alias>`, run
anywhere — the alias, not cwd, resolves the registry entry, since a loop
process is typically started from a supervisor rather than from inside the
checkout. An unregistered alias fails loudly naming the fix (add an entry).
Manual slash commands resolve the entry the same way `foreman init` does:
from the session's cwd against registry paths.

**Scope predicate.** An issue is in scope iff it belongs to the team AND its
project's initiative is in this instance's bound set. Both loops silently
skip out-of-scope issues (they belong to another instance); a manual command
against an out-of-scope issue refuses with the reason, never guesses.

**Ensure pass** (`packages/core/src/ensure.ts`, `ensureMaintenanceProjects`).
On extension `session_start` and — indirectly, through the same function —
available to the loop: verify each bound initiative exists (fail loudly,
`ConfigError`, if it does not resolve — the registry binds ids and an
unresolvable one means the binding itself is broken) and has its standing
`Maintenance` project, creating one — team-assigned, since Linear's
`ProjectCreateInput` requires `teamIds` and has no `initiativeId` — through
the `Confirmer` (a Linear write) if missing. `foreman reconcile` also runs
this pass every invocation (§17.6), so a Maintenance project created by hand
outside Foreman is picked up, not duplicated — matched case-insensitively and
trimmed by name. Milestone-sized projects come from `foreman-roadmap` (§7.6a)
or the operator directly; the ensure pass itself creates only `Maintenance`.

**Concurrent instances are already safe.** The mutex is in Linear, not in any
process: the task guard's lock-comment claim (§11, §17.4) prevents
double-work even if two instances' scopes overlap. The per-alias
`ProcessLock` (§17.4) prevents two `build` (or two `plan`) processes for the
same alias; nothing else needs coordinating.

**Triage is a `plan`-loop rule**, not a separate process (§17.1, §17.5). The
plan loop's `triage` rule batches up to `loop.triageBatch` Triage-state
issues into one `/foreman:triage --initiatives <id>... <ISSUE-ID>...`
dispatch per poll — one consumer of the shared inbox per repo instance, no
separate scheduler and no proposal step: `foreman-triage`'s
`TriageResult` is applied directly by the extension (§7.1).

**Per-instance state.** `<stateDir>/<alias>/{plan,build}.json` (in-flight
dispatch + failure bookkeeping, §17.4) and `<stateDir>/<alias>/{plan,build}.lock`
(the process lock) live under `loop.stateDir` (default
`~/.foreman/state`), keyed by the registry alias — no per-repo config
directory, so state is global too.

### 3.12 Intake-drafted issues

Removed as its own step in the loop simplification; see §7.1.
`foreman-triage`'s `TriageItem.draftDescription` is what used to be sketched
here as a `newProject { ..., seedIssues[] }` intake step — the agent drafts a
`## Context` section for an inadequately-described item at triage time, the
extension writes it verbatim, and `foreman-refine` later verifies and
revises that draft against the code (§7.2 step 3) the same way it handles
any other Backlog issue.

---

## 4. Linear data model

### 4.0 Workspace topology (pre-loop setup)

**One team for everything.** Teams are where Linear scopes the machinery:
workflow states, estimate config, the Triage inbox, team labels, and the issue
prefix are all per-team. Everything §4 configures exists exactly once only if
there is exactly one team. Products are differentiated by initiative and
project, never by team. The loop still takes an explicit team scope
(`--team`, §3.11) — one team is the recommended topology, not a hardcoded
assumption. If a product ever outgrows this, Linear sub-teams can inherit
workflow and labels from a parent — a migration path that doesn't fork
config.

**Route the operator's own issues through Triage.** Issues land in Triage only
when created by an integration, from inside the Triage view, or by a
non-member. The operator *is* a member, so self-filed issues — most inbound —
would skip straight to Backlog, bypassing classification, dedupe, and priority
proposals, then permanently fail the refinement gate untyped. Set the team's
default issue template to Triage status so everything enters through one
funnel.

**Initiatives on from day one, and load-bearing.** Initiative = the product
(§4.1); the registry's repo bindings (§3.10, §3.11) and the product
`Context` doc (§4.7) hang off it. Portfolio groupings (e.g. the weekly micro-products practice) are
naming-convention parents — `Micro-products > dontletitdie.lol` — since real
sub-initiatives are Enterprise-gated. Grouping prefixes are review lenses only;
no Foreman config attaches to them.

**Exactly one initiative per project.** Linear allows a project under multiple
initiatives; Foreman does not — repo and context resolution (§3.5, §4.7) must
be unambiguous. Validator-enforced.

**A standing `Maintenance` project per product.** Foreman-touched issues must
belong to a project (§10), because the project edge is the only path from an
issue to its repo and context. Bugs and chores outside any milestone live in
the product's standing `Maintenance` project — Linear's own recommended
pattern for work that should stay open indefinitely.

### 4.1 Hierarchy

| Level | Use |
|---|---|
| Team | **Exactly one.** Owns states, estimates, Triage, team labels, and the issue prefix (§4.0). |
| Initiative | **The product/app.** Never closes. Hosted by exactly one repo — a monorepo may host several initiatives; the global registry binds them (§3.10, §3.11). Carries the product `Context` doc (§4.7). Naming-convention parents group a portfolio (§4.0). |
| Project | **A shippable increment** — a feature or milestone that ends — or the product's standing `Maintenance` project. Carries the project brief (§4.7). |
| Issue | Unit of agent work. One issue = one worktree = one PR. |
| Sub-issue | Product of `foreman-refine` splitting an oversized issue. |

The definitional line between initiative and project is lifecycle, not size: an
initiative is a container that never closes, a project is a thing that ships
and closes. A micro-product is a product that happens to take a week — it gets
an initiative like anything else, holding a single `Launch` project.

A project's own path through this hierarchy now has a decomposition step:
`foreman-plan` (§7.6) turns a bare, newly-approved project's brief into its
first slate of issues, the moment it has none — closing the gap between
"the operator approved a project" and "there is anything in it to refine."

### 4.2 Workflow states

Linear's native set; no custom states.

| State | Meaning | Moved in by |
|---|---|---|
| `Triage` | Unprocessed inbound. | Linear inbox, operator, integrations |
| `Backlog` | Accepted, not yet refined. | extension, from `TriageResult` |
| `Todo` | **Refined and ready.** Gate §10 satisfied. | extension, from `RefineResult`; also on block, In Progress → Todo (§9) |
| `In Progress` | Worktree open, code being written. | extension, at implement dispatch |
| `In Review` | PR open, awaiting review. | extension, from `ImplementResult` |
| `Done` | Merged. | Linear's GitHub integration on merge (PR mode); the loop's merge-detection worker when `pr.required: false` (§3.10). The operator does the merging, via `/foreman:merge` or by hand |
| `Canceled` | Won't do. | extension (approved proposal) or operator |
| `Duplicate` | Merged into another issue. | extension (approved proposal) or operator |

Treat "Todo" and "Refined" as synonyms.

### 4.2a Terminal state

**Terminal means `completed` or `canceled`**, at two levels: an issue's
workflow-state type (`TERMINAL_STATE_TYPES`) and a project's native status
type (`TERMINAL_PROJECT_STATUS_TYPES`, §7.6a) — both defined once in
`packages/core/src/domain/states.ts` and read everywhere else (`isTerminal`,
`isTerminalProjectStatus`). No part of the loop acts on terminal work: the
saved views (§4.10) and loop rule predicates (§17.5) exclude it via
`notTerminalState()` / `notInTerminalProject()`
(`packages/core/src/linear/filters.ts`), except the carve-outs below, whose
whole job is processing terminal things.

`paused` is explicitly **not** terminal. It carries no claim that the work
is over — it is a reversible operator hold, not an abandonment — so it stays
out of the terminal definition above and out of every terminal carve-out.
It is, however, not read-nowhere: refinement alone honors it (§4.2b).
Everything else keeps running exactly as if the project were active —
implement, review, `foreman reconcile`, and the plan loop's rules all still
act on a paused project's issues.

| Carve-out | Why it must still see terminal work |
|---|---|
| `foreman reconcile`'s invariants (§11, §17.6) | A lock held on an issue that has since been completed or canceled is exactly the stale state reconcile exists to clean up. |
| the `merged-not-done` invariant (§17.6) | Marking a merged issue Done *is* the terminal transition — skip it and the issue is stranded In Review forever. |
| the project-status invariant (§7.6a, §17.6) | It is the thing that writes `completed` in the first place. |

### 4.2b Paused projects

A `paused` project status (§7.6a) withholds exactly one thing: refinement
never picks up that project's issues. Nothing else changes.

Refinement is the transition that *commits* new work — its output is an
issue moved to Todo, estimated with acceptance criteria, which implement
then picks up unattended. Pausing a project withholds that commitment and
nothing more; it is not a recall of work already committed. So implement,
review, merge-detection, `foreman reconcile`, and the plan loop's rules all
keep treating a paused project's issues normally — an issue already in Todo
still gets implemented, its PR still gets reviewed and merged, and a stale
lock on it still gets reconciled. Only the plan loop's `refine` rule (§17.5)
excludes a paused project's issues, via `notInPausedProject()`
(`packages/core/src/linear/filters.ts`), alongside `notInTerminalProject()`.
The same hold applies to `/foreman:refine` (§10), via `evaluateGate`'s
`paused-project` refusal.

### 4.3 Priority

Linear's native Priority is the **single** urgency/severity axis. No separate
severity label group — for one person who both files and prioritizes, severity
and priority never diverge, and two fields means two things to keep in sync for
no decision benefit.

| Priority | Meaning | Routing |
|---|---|---|
| `Urgent` | Production broken, data loss, security. | Interrupt in-flight work. |
| `High` | Major breakage, no workaround; or committed roadmap work. | Next pickup. |
| `Medium` | Normal work. | Normal queue order. |
| `Low` | Cosmetic, edge case. | Cancellation candidate at 90 days untouched. |
| `None` | **Unprioritized.** | Not eligible for refinement (§10). |

`None` is load-bearing: it makes "only refine the prioritized top" a
machine-checkable predicate rather than a rule agents are trusted to follow.

Set by the operator during weekly review. `foreman-triage` proposes a priority,
but proposals are inert until approved (§7.1). Severity reasoning lives as a
field in the triage output schema, not as persistent Linear state.

### 4.4 Dependencies

Use Linear's **native issue relations** (`blocks` / `blocked by`) for every
issue-to-issue dependency. Never labels.

Native relations are bidirectional, auto-resolve when the blocker completes, and
make the implementation gate a real query. A dependency label is manual state
with no resolution path — the blocker merges, nothing clears the label, and the
issue sits in the Blocked view until someone notices.

Labels remain the mechanism only for blocks with no issue to point at (§4.5).

### 4.5 Labels

Every label must be consumed by a gate validator or agent predicate; if nothing
reads it, delete it. Mutually exclusive groups marked ⊕.

**`type:` ⊕** — `type:bug`, `type:feature`, `type:chore`, `type:spike`,
`type:docs`. Required on every issue leaving Triage.

**`foreman:` ⊕** — the one managed group, written only by the Foreman
extension. Collapses the former `agent:*` / `blocked:*` split and the
`legacy` amnesty marker into a single group, since the loop's own state
(`InflightStore`, §17.4) now carries what `agent:proposed` and
`agent:ready` used to encode, and refinement's own predicate (§17.5) now
carries what `legacy` used to encode (§4.9).

| Label | Meaning |
|---|---|
| `foreman:running` | An agent holds this issue. Acts as a lock (§11); mirrors the loop's own in-flight state so the Blocked/In-flight views (§4.10) don't require reading `InflightStore` directly. |
| `foreman:blocked` | The human interrupt queue. Applied on escalation (§17.7) or by an agent's `BlockRecord` (§9). Cleared by `/foreman:unblock`. |
| `foreman:hands-off` | Agents must never touch this. Operator escape hatch. |

**`triage:` ⊕ (optional)** — `triage:cannot-reproduce`, `triage:duplicate`,
`triage:needs-info`, `triage:wont-fix`.

**`area:` (optional)** — derive from the repo's real structure at build time.
Build only if `foreman-implement` uses them to scope initial reads.

> `type:` and `foreman:` are load-bearing. The rest are optional.
### 4.6 Estimates

Fibonacci, read as *agent-session size*, not human time.

| Points | Meaning |
|---|---|
| 1 | Single file, obvious change, no design decisions. |
| 2 | A few files, clear acceptance criteria. |
| 3 | Multiple files, one non-obvious decision. |
| 5 | **Split it.** `foreman-refine` must decompose. |
| 8 | Not an issue. Convert to a project or a spike. |

### 4.7 Context documents

Two layers, split by lifecycle:

**Product `Context` doc — on the initiative.** Architectural decisions and
constraints, domain vocabulary, known non-goals, and the Definition of Done
(§4.8). Stable across milestones — one copy per *project* would rot into N
drifting copies of the same decisions.

**Project brief — on the project.** The increment's problem statement and
success criteria, nothing product-wide. For a micro-product's single `Launch`
project the brief carries everything and the product doc can start as a stub.

The task tool's required `context` parameter gets a digest of **both**,
concatenated product-first, which omp renders into every spawned subagent's
system prompt. Operator maintains them; agents may propose edits as comments
but must not write to them.

**Verify during build:** documents attach at the initiative level on the
current plan (§16). If not, the product `Context` doc lives pinned in the
product's `Maintenance` project and resolution follows the same chain.

### 4.8 Definition of Done

A **per-product** quality bar in the product `Context` doc (§4.7), separate
from per-issue acceptance criteria: tests written and passing, lint and typecheck clean, no new
LSP diagnostics, docs updated if public API changed.

Without it, every acceptance-criteria list restates the same boilerplate,
`foreman-refine` wastes output on it, and `foreman-review` checks a target that
drifts per issue. Acceptance criteria cover only what is specific to the issue;
`foreman-review` checks both.

### 4.9 Pre-existing issues

Issues predating Foreman have no template, no estimate, no priority — and may
sit in any state, including Todo. There is no amnesty label: a pre-existing
Todo issue is simply held by the same implementation gate as any other (§10)
— missing acceptance criteria and an unset estimate fail it exactly like an
issue Foreman itself created but hasn't refined yet. The plan loop's `refine`
rule (§17.5) does not distinguish "pre-existing" from "created by
`foreman-plan`" — both are just unrefined Backlog/Todo issues with a
priority set, and the rule picks either up the same way. Priority remains
the throttle: an unprioritized issue waits like any other, refined or not.
Projectless pre-existing issues get homed at install time — default
destination the product's `Maintenance` project — since the refinement gate
requires project membership (§10).

### 4.10 Required saved views

1. **Inbox** — state = Triage
2. **Blocked** — `foreman:blocked`, excluding terminal issues and issues in a terminal project (§4.2a)
3. **Blocked (deps)** — incomplete `blocked by` relation, same terminal exclusion
4. **Ready** — Todo AND estimate set AND priority ≠ None, plus excludes issues in a terminal or paused project (the `Todo` clause already rules out a terminal *issue* state)
5. **In flight** — `foreman:running` — deliberately unfiltered (§4.2a carve-out 1); `foreman reconcile` needs it to see locks on issues that finished mid-hold

**Verify during build:** Linear can filter on relation *existence*; whether it
can filter on *incomplete* blockers specifically is unconfirmed. If it can't,
keep views 2 and 3 separate rather than contorting a compound filter — a filter
that silently under-reports costs a stalled issue; two views cost nothing.

View 2's count is the backpressure signal (§17.7): without the terminal
exclusion, `foreman:blocked` stranded on a canceled issue held the entire
loop stopped with no operator remedy short of finding and unlabeling it by
hand. View 1 is unfiltered because triage is never terminal by construction.

### 4.10a Project dependencies

Linear models a project dependency as a `ProjectRelation` of `type:
"dependency"` anchored `end` -> `start`: the source project's finish gates
the target project's start. Read from the target that edge is "blocked by";
read from the source it is "blocks" — the project-level mirror of §4.4's
issue relations. The other anchor pairs Linear permits (`start`/`start`,
`end`/`end`) express alignment, not a prerequisite, and are deliberately
never treated as blockers.

`ProjectFilter` has the same gap §4.10's saved views hit for issues: it can
answer "has a dependency edge" and nothing about the blocker's state, so
completeness is evaluated in code from the blocker's own project status —
`completed` or `canceled` resolves it, anything else does not
(`projectBlockerIsResolved`, `incompleteProjectBlockers`).

Project relations are fetched **per project**, never nested under
`initiative.projects(first: 250)`: querying both relation connections on
every project inside that one page exceeds Linear's query-complexity
ceiling (`Query too complex`), so a candidate project's relations are read
in their own, separate call.

---

## 5. Subagent frontmatter contract

Frontmatter sets the contract; the body is the system prompt. These fields are
the enforcement surface — everything expressible here must be here rather than
in prose.

| Field | Behavior | Foreman policy |
|---|---|---|
| `tools` | Explicit allowlist. `hub` is force-added regardless. `exec` expands to `eval` + `bash`. `task` is auto-added if `spawns` is set. | The security boundary. Enumerate per agent (§7). No agent gets any Linear or GitHub mutation tool except implement's `foreman_github_pr` (principle 9). |
| `spawns` | Grants the child the `task` tool so it can fan out further. | **`false` on all six.** Recursive fan-out inside a workflow agent is exactly the uncontrolled behavior Foreman exists to prevent. Set explicitly; do not rely on the depth gate. |
| `blocking` | `true` runs the spawn inline; default is a background job whose result is delivered into the parent conversation later. No bundled agent sets it. | `true` only for `foreman-refine` (short-lived; inline is right both when the operator invokes it and in the loop's print-mode parent). Everything else background. |
| `thinking-level` | The agent's effort selector. `auto` does per-prompt classification. Per-spawn `effort` overrides it, but only when `task.enableEffort=true` (default off) — so in practice frontmatter is the real control. | Per agent, §7. Don't rely on `effort` unless you enable the setting. |
| `output` | JSON Schema for structured output. Precedence: per-call `outputSchema` → frontmatter `output` → inherited parent schema. Pair with `schemaMode: strict`. | **Required on all six.** See §6. |
| `advisor` | Pairs the child with an advisor session that raises concerns and blockers mid-run. `on` / `off` / model pattern. Subagents default to none. | `on` for `foreman-refine` and `foreman-plan` — the two agents that draft, rather than verify against code, so a second opinion is cheap insurance. The advisor interrupts the *agent*, not the operator — it does not violate §9. |
| `prewalk` | Starts on the normal model and hands off to a cheaper one at the first edit/write. | **`false` everywhere.** For `foreman-implement` the edits *are* the hard part; downgrading exactly when writing begins is backwards. |
| `autoload-skills` | Skill names loaded **before the first assignment**, as CSV or a list. **Unknown names are silently ignored** — no error, no warning. | Bind each agent's procedure skill plus `foreman-block-protocol`. Guard against the silent-ignore failure mode (§8). |

Two runtime facts that constrain all of the above:

- **`tools.approvalMode` is forced to `yolo` for child sessions.** Subagents are
  headless and have no UI to confirm against. The tool allowlist is the only
  thing standing between an agent and an irreversible action.
- **The child must terminate through the hidden `yield` tool.** Up to three
  reminders, the last forcing `toolChoice = yield`. Structured output arrives in
  the yield payload, so the block protocol (§9) must terminate through yield
  too — not by simply stopping.

---

## 6. Structured output

Every agent returns a validated object. This is the largest single change from a
prose-artifact design: gate checks become schema validation, and the extension
drives Linear from `structuredOutput.data` instead of parsing markdown.

Set `schemaMode: strict` on all six. Permissive mode defeats the purpose.

With principle 9, these objects are not just the return channel — they are the
*complete* specification of every mutation the extension applies. Anything an
agent wants changed in Linear must be expressible in its result schema, or it
doesn't happen.

Sketch schemas — refine during build, but keep the shapes:

```
TriageItem
  issueId, type, proposedPriority, severityReasoning,
  destination: "backlog" | "new-project" | "cancel" | "duplicate",
  destinationProjectId?, newProject? { name, description, initiativeId },
  duplicateOf?, proposedBlockedBy[], draftDescription?, proposedEstimate?,
  missingInfo[]
TriageResult
  items: TriageItem[], summary

PlanResult
  projectId, proposedIssues[]: { key, blockedBy[], title, type, description,
             acceptanceCriteria[], proposedPriority, proposedEstimate? },
  outOfScope[], fullyPlanned, rationale

RefineResult
  issueId, refinedDescription, estimate, acceptanceCriteria[],
  affectedAreas[], outOfScope[], subIssues[], spikeCreated?,
  readyForImplementation

ImplementResult
  issueId, branch, prUrl, headSha, criteriaMet[], testsAdded[],
  discoveredWork[], approachSummary

ReviewResult
  issueId, reviewedSha,
  criteriaVerification[]: { criterion, satisfied, evidence },
  dodSatisfied, findings[]: { severity, file, line, description },
  projectOrganization, verdict
```

BlockRecord
  blocked: true, type, whatIWasDoing, whatINeed,
  options[]: { label, tradeoff }, recommendation,
  stateLeftBehind: { worktree, branch, pushed, commits[], notes },
  costOfWrongGuess, blockedByIssues[]
```

A union of the normal result and `BlockRecord` is what each `output` schema
declares. The extension branches on `blocked` — that is the whole interrupt
protocol reduced to a discriminated union, which is far more reliable than
regex-matching a markdown heading.

**A keyed dependency graph is validated at parse time, not applied
partially.** `foreman-plan`'s `proposedIssues[]` and `foreman-roadmap`'s
`proposedProjects[]` (§7.7) each carry a `key` and a `blockedBy[]` of
sibling keys — the only way to express order among entries that don't exist
in Linear yet. Duplicate keys, a `blockedBy` referencing a key not in the
result, a self-block, and a cycle are all schema-adjacent checks JSON Schema
cannot express, so they run once, from the shared graph validator, and any
violation makes the whole result `invalid` rather than creating the entries
that do resolve. A cycle in particular can never be partially applied
correctly: every entry in it gates on another, so none could ever be picked
up, and a slate with an unbuildable cycle inside it is not an improvement
over rejecting the whole proposal.

The Markdown artifacts in §13 are still produced, but as *renderings* of the
structured data written into Linear, not as the agent's return channel.

---

## 7. Agents

### 7.1 `foreman-triage`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: true
model: "@default"
advisor: off
prewalk: false
autoload-skills: [foreman-triage-inbox, foreman-block-protocol]
output: schemas/triage-result.json
schemaMode: strict
```

| | |
|---|---|
| **Transition** | `Triage → Backlog / Canceled / Duplicate` |
| **Trigger** | The plan loop's `triage` rule (§17.1, §17.5), batched up to `loop.triageBatch` Inbox issues per dispatch. Never called mid-flow by another agent. |
| **Model role** | default — drafting full descriptions outgrew `smol` |

No Linear mutation surface of any kind, no `edit`, no `write`, no `bash`.
Read-only by construction. Scope is one batch of the team's Triage inbox
(§4.10); repro and context reads resolve repos through the `repos` registry
(§3.10) — no filesystem scanning.

**Per item:** classify (`type:`), dedupe by semantic similarity, attempt repro
*by reading only*, propose a Priority with severity reasoning, flag missing
information, propose native `blocked by` relations, and choose a
`destination` — an existing project (`backlog`, with `destinationProjectId`
set — a milestone or the product's standing `Maintenance` project, §4.0),
`cancel`, or `duplicate`. `foreman-triage` never creates a new project
itself; an item that deserves one is filed to `Maintenance` with
`missingInfo` noting it, for the operator or `foreman-roadmap` to size
properly (§7.7). When the existing description is inadequate, draft one in
`draftDescription` (§13.1-shaped `## Context` prose).

**Output:** a `TriageResult`. **The extension applies every item directly**
(§3.1, §7 — there is no separate operator-approved proposal step): moves the
issue per `destination`, sets priority and the `type:` label, creates the
native `blocked by` relations, writes `draftDescription` when present, and
leaves a comment recording what changed. A mutation is still gated: schema
validation plus the same `Confirmer` (§17.9) every other extension write
goes through, so nothing lands unvalidated — but nothing waits on a human
to remove a label first.

**Known gap — `destinationProjectId` resolution is the agent's job, not the
extension's.** `foreman_linear_read` gives the agent the team's real projects
to choose from, so an ambiguous "which `Maintenance` project" question
(monorepo with two initiatives, §4.0) is resolved by the agent reading
context, not by a post-hoc name match. An item the agent genuinely cannot
place gets `destination: "backlog"` against the team's default
`Maintenance` project and a `missingInfo` note — attaching an issue to the
wrong product's project is worse than filing it generically for a human to
re-home.

**Permission:** may recommend `Canceled` freely. Un-actioned `Low` items older
than 90 days should be proposed for cancellation by default.

**Weakest link:** dedupe against a large backlog. The schema's
`severityReasoning` field is the tuning log — read it for the first week
before touching the threshold.

### 7.2 `foreman-refine`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: true
model: "@plan"
advisor: on
prewalk: false
autoload-skills: [foreman-refine-issue, foreman-spike, foreman-block-protocol]
output: schemas/refine-result.json
schemaMode: strict
```

Blocking because it's short-lived — inline is right both when the operator
invokes it deliberately and in the loop's print-mode parent. Advisor on because
refinement quality is where reasoning actually pays, and a second opinion
catching a bad split before implementation is cheap. Model role `plan` for the
same reason — drafting a description and split that survives implementation is
a reasoning task, not a lookup.

1. Verify Priority ≠ `None`. Refuse if unprioritized.
2. Read the product `Context` doc and the project brief (§4.7), Definition of
   Done included.
3. Draft the `## Context` prose for the §13.1 description — or, for
   intake-drafted issues (§3.12), verify and revise the draft against the
   code. Returned as `refinedDescription`, never written directly: the
   extension renders the template around it from `acceptanceCriteria`,
   `affectedAreas`, and `outOfScope`, so the agent never emits the headings.
4. Acceptance criteria as observable behaviors, verifiable by someone who didn't
   write the code. Do not restate the Definition of Done.
5. Identify affected files/modules via LSP, not guesswork.
6. Estimate. If ≥5, specify the split in `subIssues[]` with per-sub-issue
   estimates; the parent becomes a tracking issue that stays out of the
   `implement` rule's candidates until its sub-issues are refined.
7. If a genuine unknown blocks estimation, specify a `type:spike` (§13.3) in
   `spikeCreated` with a native `blocks` relation to the original. Do not guess.
8. Yield the `RefineResult`. The extension applies it: description, sub-issues,
   spike, move to Todo.

Step 1 is the enforcement mechanism for "never bulk-refine the backlog."

### 7.3 `foreman-implement`

```yaml
tools: [read, edit, write, search, lsp, dap, exec,
        foreman_linear_read, foreman_github_pr]
spawns: false
blocking: true
model: "@default"
advisor: off
prewalk: false
autoload-skills: [foreman-implement-issue, foreman-block-protocol]
output: schemas/implement-result.json
schemaMode: strict
```

Runs **non-isolated** in a Foreman-created worktree (§3.7). `prewalk: false` is
load-bearing here, not a default — see §5. `foreman_github_pr` is the one
mutation tool any agent holds — the PR must exist before yield so the block
protocol can reference it. Model role `default` — editing against a concrete
contract is not where the reasoning budget goes; `prewalk: false` is what
guards against downgrading mid-edit, not a stronger role.

1. Verify the lock. The extension claimed `foreman:running` with this dispatch's
   ID before the spawn (§11, §17.5); if the ID doesn't match, abort. The agent
   never claims, clears, or refreshes the lock itself.
2. **Resume check.** If the worktree already contains prior work, this is a
   resume, not a fresh start: read the earlier `BlockRecord` or review findings,
   the operator's reply, and the partial commits, then continue (§9).
3. Implement against the acceptance criteria *and* the Definition of Done. The
   criteria are the contract; out-of-scope discoveries go in `discoveredWork`
   and become new Backlog issues with native relations — created by the
   extension, not the agent.
4. Tests covering each acceptance criterion.
5. Open a PR (§13.2) linking the issue — or, when the repo sets
   `pr.required: false` (§3.10), push the branch and skip the PR; `prUrl`
   stays empty in the result.
6. Yield the `ImplementResult`. The extension moves the issue to In Review,
   releases the lock, and files `discoveredWork`.

### 7.4 `foreman-review`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: true
model: "@slow"
advisor: off
prewalk: false
autoload-skills: [foreman-review-diff, foreman-block-protocol]
output: schemas/review-result.json
schemaMode: strict
```

Model role `slow`. Read-only everywhere — the Linear review comment (§13.4) and
the PR review are rendered by the extension from the `ReviewResult`.

Inputs are the diff, the issue, and the Context docs (§4.7). The agent holds no git
or GitHub tool, so the extension fetches the diff and head SHA at dispatch —
from the PR via its GitHub read client (§3.5), or from git (`baseBranch..head`)
when `pr.required: false` (§3.10) — writes them to a file, and passes the
path in `context` — the agent `read`s it. Test adequacy is judged by reading,
not execution: "would these tests fail if the change is reverted?" is answered
by inspection. Child sessions don't inherit history, so cold context holds
structurally — what *does* carry over is the workspace tree, skills, context
files, and the shared `local://` root. Don't put implementation rationale in
`context`.

Checks: each acceptance criterion satisfied with file:line evidence; Definition
of Done satisfied; correctness and edge cases; test adequacy (do tests fail if
the change is reverted?); **project organization** — structure, module
boundaries, naming, placement, as a standing field on every review; scope creep.

Findings classified `blocking` / `should-fix` / `nit`.

**The fix cycle.** `reviewedSha` pins what was reviewed, which makes both halves
of the cycle machine-checkable: the review rule re-dispatches whenever the
PR's head SHA has no `ReviewResult` (§17.5), and blocking findings route back
automatically — the extension writes the findings to the issue and re-dispatches
implement, which lands in resume mode (§7.3 step 2), pushes fixes, and yields an
updated result; the new head SHA triggers re-review. After **`loop.reviewCycleCap`**
(default 2) `request-changes` verdicts without converging, the build loop
escalates to `foreman:blocked` with the failure detail attached (§17.7) — a
standing disagreement between implement and review is operator information,
not something to ping-pong overnight.

**No merge authority of its own.** `foreman-review` never merges; that is
`/foreman:merge`, gated by `loop.autoMerge` (default off, §17.6). A clean
`ReviewResult` only satisfies the review gate — it does not act on it.

### 7.5 Explicitly not an agent

**Prioritization and roadmap sequencing beyond `/foreman:roadmap`.** Requires
context that cannot be reconstructed from the repo or Linear. Operator,
weekly, ~1 hour.

**Applying `TriageResult`, `PlanResult`, and `RoadmapResult`.** Deterministic
once the agent has decided; extension code (§7.1, §7.6, §7.7).

### 7.6 `foreman-plan`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: true
model: "@plan"
advisor: on
prewalk: false
autoload-skills: [foreman-plan-project, foreman-block-protocol]
output: schemas/plan-result.json
schemaMode: strict
```

| | |
|---|---|
| **Transition** | none — creates new Backlog issues under a project; touches no existing issue's state |
| **Trigger** | The loop's `plan` worker (§17.5), at any in-scope, non-Maintenance project with zero issues in any state and zero incomplete project blockers (§4.10a). Never called mid-flow by another agent. |
| **Model role** | `plan` — decomposing a brief into a coherent issue set is a drafting task, not a lookup |

This is the gap §3.12's `newProject { ..., seedIssues[] }` sketch always
implied but nothing ever filled: intake can *propose* a milestone project,
and the operator can approve or create one by hand, but until now nothing
turned an approved project's bare brief into the issues that actually ship
it. `foreman-plan` closes that gap as its own agent rather than folding
decomposition into triage, because a project can go bare after intake in
ways intake never sees — created by the operator directly, or emptied back
out later — and because drafting a full issue set is a different task, at a
different grain, than classifying one inbox item.

**Per bare project:** read the project brief and the product `Context` doc,
split the brief into agent-sized slices (the same scale `foreman-refine`
estimates against, §4.6), and draft each as a `ProposedIssue` — title,
`type:`, the `## Context` prose for a §13.1 description (the extension
renders the template; the agent never writes the headings), draft acceptance
criteria, a rough priority, and a rough estimate. Record explicit non-goals
in `outOfScope`.

**The decomposition ships its own dependency graph.** Each `ProposedIssue`
carries a `key` and a `blockedBy[]` of sibling keys, so a project that
decomposes into an ordered set of slices says so before any of them exist
in Linear. That has to be the agent's job: the implementation gate reads
native relations (§10), and a sequence expressed only as array order or
prose in the description is invisible to it — five issues shipped in "the
right order" with no relation between them gates nothing, and
`foreman-implement` is free to pick up the last one before the first
merges. The extension resolves each `blockedBy` key against the sibling
issue it created for that key and applies it as a native `blocks` relation
(`applyPlan`), the same mechanism §4.4 already uses for hand-authored
dependencies.

**Output:** a `PlanResult`. The extension creates each `proposedIssues[]`
entry as a new Backlog issue under the project, and marks the project
`planned` (§7.6a) — nothing else. Every one enters the normal refine funnel
the moment the operator sets a priority, exactly the path any other Backlog
issue takes. `foreman-refine` verifies and revises each draft against the
code before it reaches Todo, the same way it already handles intake-drafted
issues (§3.12) — `foreman-plan` is deliberately not expected to get every
draft right; it only has to get the decomposition right.

**One-shot, not a buffer.** Unlike refine's Ready-buffer top-up (§17.6),
plan does not maintain an ongoing backlog depth per project. A project is a
candidate exactly when it has zero issues; the moment `foreman-plan` creates
its first one, Linear's own state removes it from `planCandidates` on the
next tick, so no separate "fully planned" flag has to be written anywhere
(§7.6 known gap, below). A project's scope growing later is new issues filed
the normal way — triage, the operator, or `discoveredWork` from implement —
not a second plan pass.

**Known gap — `fullyPlanned` is informational only.** `PlanResult` carries a
`fullyPlanned` boolean, but Foreman has no durable per-project flag to write
it to: Linear projects carry no label surface, and repurposing the
project's own `description` (an operator-facing field) for internal
bookkeeping was rejected as worse than the gap it would close. So a
deliberately thin first pass (`fullyPlanned: false`) does not schedule a
follow-up on its own — it is a signal the operator reads off the loop log
or `/foreman:status`, not a queued dispatch. Closing this properly means
giving Linear (or Foreman's own state) a real per-project marker; until
then, `foreman-plan` should default to proposing the smallest *complete*
slice it can rather than banking on a pass that isn't coming.

**No Linear-visible block surface.** A `BlockRecord` from `foreman-plan` has
no existing issue to attach `foreman:blocked` to — the project has none yet
by construction. The extension logs the block rather than writing it to
Linear (§9's Case B assumes an issue exists). Reserve blocking for a brief
with nothing to decompose at all; a thin brief is not a block.

### 7.6a Project status

Linear projects carry their own native status — `backlog` / `planned` /
`started` / `paused` / `completed` / `canceled` — a separate axis from any
per-issue workflow state (§4.2). Before this section, Foreman never touched
it: the field sat on every project, unread and unwritten. It is now a driver,
not decoration — the operator reads a project's shipped/underway/dormant
state directly off the Linear UI they already look at, instead of opening it
to count issues.

**Deterministic, not agentic.** No agent sets this; it is extension/loop
code, the same authority class as `foreman-triage`'s direct-apply (§7.1) and
the lock sweep (§11) — a plain function over already-fetched state, not a
model call.

| Transition | Trigger | Who |
|---|---|---|
| *(create)* → `planned` | `foreman-plan` creates a project's first slate of issues (§7.6) | `applyPlan`, same mutation batch |
| `backlog`/`planned` → `started` | Any issue reaches an active or completed workflow-state type | `foreman reconcile`'s project-status pass (§17.6) |
| any → `completed` | Every issue is terminal (completed or canceled) and at least one completed | `foreman reconcile`'s project-status pass |

**Deliberately restrained.** Only the two directions with no reasonable
disagreement are automated. `paused` and `canceled` are exclusively the
operator's call and are never *written* by the loop — a project the operator
paused or canceled stays exactly where they left it regardless of what its
issues do afterward. An all-`canceled` issue set does not auto-complete a
project either: that is abandonment, a judgment call, not a shipped
increment. `canceled` is, however, read as an input elsewhere: it is
terminal (§4.2a), so the `plan` worker's bare-project gate now skips a
canceled project the same as a completed one — there's nothing left to plan
for. `paused` is not terminal, but it is read as a decision input in
exactly one place: refinement withholds new commitments from a paused
project (§4.2b). Nowhere else does it change behavior.

**Bare-project exclusion.** A project with zero issues never transitions —
that is `foreman-plan`'s own trigger condition (§7.6), not this worker's; the
two never compete for the same project at the same time. The standing
`Maintenance` project (§3.11) is excluded entirely, the same guard `plan`
uses — it never closes, so it is never a `completed` candidate.

### 7.7 `foreman-roadmap`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: true
model: "@plan"
advisor: on
prewalk: false
autoload-skills: [foreman-plan-roadmap, foreman-block-protocol]
output: schemas/roadmap-result.json
schemaMode: strict
```

| | |
|---|---|
| **Transition** | none — creates one or more new projects under an initiative; touches no existing project or issue |
| **Trigger** | `/foreman:roadmap`, operator-invoked only. Never a loop worker, never called mid-flow by another agent — the same standing as `foreman-triage`'s intake pass. |
| **Model role** | `plan` — sequencing a set of projects from a brief is a drafting task, the initiative-level analog of `foreman-plan`'s issue decomposition (§7.6), not a lookup |

`foreman-plan` turns one bare project into its issues; nothing before this
section turned an initiative's brief into the *projects* that will
eventually go bare. An operator who already has a roadmap in their head —
"ship the schema, then the API, then the UI, landing by end of quarter" —
had no way to get that structure into Linear except creating each project
by hand and wiring relations one at a time.

**Per invocation:** read the initiative's brief and any existing sibling
projects (for naming and dependency context), and draft each new increment
as a `ProposedProject` — `key`, `name`, `description`, and a `brief` in the
same §4.7 shape `foreman-plan` later decomposes. `blockedBy` names sibling
`key`s in this same result; `blockedByExisting` names already-created
projects a new one depends on. Both are the project-level dependency graph
(§4.10a), validated the same way as `foreman-plan`'s (§6). `startDate` and
`targetDate` are proposed `TimelessDate`s reasoned from the brief and from
existing projects' own dates (`latestTargetDate`) — informational scheduling
input, never a gate (§4.10a already gates on the relation, not the date).

**Output:** a `RoadmapResult`. The extension applies it deterministically,
the same authority class as `foreman-triage`'s direct-apply (§7.1) and
project status (§7.6a) — the agent proposes, the extension is the sole
writer (principle 9):

1. Create each `proposedProjects[]` entry as a Linear project and attach it
   to `initiativeId` (`initiativeToProjectCreate`, two mutations — the
   window between them is the same one §4.0's ensure pass already tolerates).
2. Set `startDate`/`targetDate` from the proposal, as `TimelessDate`s.
3. Create a native `dependency` `ProjectRelation` (`end` -> `start`, §4.10a)
   for every `blockedBy` and `blockedByExisting` edge, resolving `blockedBy`
   keys against the projects just created in step 1.
4. Clamp a dependent project's `startDate` forward when it precedes a
   blocker's `targetDate`, shifting `targetDate` by the same amount so the
   proposed duration survives the clamp — a brief drafted before every
   sibling's dates were final should not silently schedule a project to
   start before its own prerequisite finishes.

`foreman-roadmap` never decomposes a project into issues itself — that is
still `foreman-plan`'s job, run automatically the moment a created project
goes bare (§7.6), the same funnel any other bare project falls into.

---

## 8. Skills

| Skill | Bound to | Produces | Authority |
|---|---|---|---|
| `foreman-triage-inbox` | triage | `TriageResult` | Applies directly |
| `foreman-plan-project` | plan | `PlanResult` | Creates issues under one bare project |
| `foreman-plan-roadmap` | roadmap (operator-invoked) | `RoadmapResult` | Creates one or more projects under one initiative |
| `foreman-refine-issue` | refine | `RefineResult` | Applies to one prioritized issue |
| `foreman-spike` | refine, operator | Findings + follow-up issues | Investigation only; no production code |
| `foreman-implement-issue` | implement | `ImplementResult` | Full within acceptance criteria |
| `foreman-review-diff` | review | `ReviewResult` | Advisory only |
| `foreman-block-protocol` | all six | `BlockRecord` | — |

Each skill defines: preconditions (the gate it enforces), required reads,
ordered procedure, the output schema it fills, **stop conditions** (the
enumerated cases requiring §9), and explicit non-goals.

`foreman-implement-issue` must include the **resume procedure** as a first-class
path, not an afterthought: detect existing worktree → read prior
`BlockRecord`/findings and the operator's reply → continue from partial commits.
This is the path both `/foreman:unblock` fresh-spawn fallback (§9) and the
review fix cycle (§7.4) depend on.

`foreman-block-protocol` bound to all six via `autoload-skills` is what makes
the interrupt contract guaranteed rather than discretionary — it is in context
before the agent's first assignment, so there is no path where an agent
improvises its blocking behavior because it didn't think to load the skill.

**Autoloaded skills defeat progressive disclosure.** The SKILL.md body is
injected up front on every spawn whether or not it gets used, so it is paid for
on every run. Keep autoloaded bodies to the procedure itself; push reference
material, examples, and edge-case catalogs into sibling files under the skill
directory that the agent reads on demand. `foreman-block-protocol` in particular
should be short — it is loaded five times over on every workflow pass.

**Guard the silent-ignore failure mode.** Unknown names in `autoload-skills` are
dropped without an error, and skill-name dedup across providers is first-wins —
so a same-named user skill shadows Foreman's, and a typo means the skill simply
isn't there. Either way the agent runs happily without its procedure or its
block protocol, and nothing tells you. The extension must verify on
`session_start` that every `foreman-*` skill name resolves to the
Foreman-provided file and fail loudly otherwise. The `foreman-` prefix reduces
collision odds; it does not remove them, and it does nothing about typos.

---

## 9. Interrupt protocol

The highest-value mechanism in Foreman. Build it before any agent.

**Rule:** no agent asks the operator a question in-session. The runtime already
makes this impossible to do usefully — headless children have no approval UI —
so an agent that "asks" simply stalls and burns budget.

**Case A — blocked by another issue.** Specify the native `blocked by` relation
in the `BlockRecord` (the extension creates or verifies it and comments naming
the blocker). Apply **no** `foreman:blocked` label; the relation is the state
and resolves itself. Yield a `BlockRecord` with `type: dependency`; the
extension releases the lock and moves the issue back to Todo. The incomplete
relation now fails the implementation gate, so the implement rule skips it;
when the blocker completes, the relation resolves, the gate passes, and the
next loop pass re-dispatches — landing in resume mode (§7.3 step 2). No
manual step.

**Case B — blocked on a human.** Yield a `BlockRecord` with the question or
enumerated options, the recommendation, the state left behind (worktree path,
partial commits), and the cost of a wrong guess. The extension writes the Linear
comment, applies `foreman:blocked`, releases the lock, moves the issue back
to Todo, and leaves the worktree intact with the branch pushed. The label keeps
every rule away (§17.1) until the operator answers.

Budget exhaustion (§3.6) converts into Case B rather than a silent stall. This is
well-supported: a soft-budget abort on a non-isolated kept-alive agent leaves the
agent `idle` and resumable.

**Resuming.** `/foreman:unblock <ISSUE-ID>` records the operator's reply as a
comment and clears `foreman:blocked`.
That is the whole command: with the issue back in Todo and the label gone, the
implementation gate passes and the next loop pass re-dispatches implement,
which lands in **resume mode** (§7.3 step 2, §8) — the skill's first move on
finding an existing worktree is to read the prior `BlockRecord` and the
operator's reply, then continue rather than restart. When the original agent's
process is still alive (interactive or herdr-dispatched sessions), messaging
the parked agent via `hub` is a cheaper resume — it already holds the context,
and messaging a parked agent revives it — but under the loop's
`PrintDispatcher` the process is gone by the time the reply arrives (§11), so
resume-mode re-spawn is the normal path and hub revival the optimization.

Non-isolated execution is what makes both paths possible: the worktree survives
the block for resume mode, and a live agent can be revived at all — isolated
agents park **without a reviver** and cannot be messaged back to life.

The operator drains **Blocked (human)** once or twice daily via
`/foreman:status`. Forcing agents to *write down* their confusion is a quality
signal — a vague `BlockRecord` usually means the issue was under-refined, which
is diagnostic information about the refine step.

---

## 10. Gates

Validator functions in the extension, consumed by agents, commands, and hooks.
Never reimplemented in prose. Pre-existing issues never bypass a gate — an
unrefined Todo issue fails the implementation gate the same way any other
unrefined issue would (§4.9, §10).

**Refinement gate** (`Backlog → Todo`): issue state not terminal (§4.2a,
checked first — finished work is never refined or implemented, regardless of
what else is wrong with it); has a project; Priority ≠ `None`; description
has `## Acceptance Criteria` with ≥1 item; estimate set and ≤3.

**Implementation gate** (`Todo → In Progress`): refinement gate satisfied;
issue state is Todo (`unstarted`); carries no `foreman:` label at all — not
just `foreman:blocked`/`foreman:hands-off`, but also `foreman:running`,
since a second claim on an already-locked issue must fail the same check a
block or a hands-off does; no incomplete `blocked by` relations.

**Terminal project, paused project.** The gates above are pure functions
over the issue alone and read no network — a project's status is a
separate fetch, so both project-status refusals are layered on top by the
caller (`task-guard.ts`'s `evaluateGate`), not part of `refinementGate` or
`implementationGate` themselves. This is the path the saved views' and
stage workers' server-side filters (§4.2a, §4.2b) cannot reach: an operator
typing `/foreman:refine ENG-1` or `/foreman:implement ENG-1` never goes
through a saved view. The two refusals differ in reach: `terminal-project`
closes out both refine and implement, but `paused-project` applies only
when `stage === "refine"` — a pause withholds new commitments, not work
already in flight, so implement is never refused on it.

**Review gate** (`In Review → Done`): a `ReviewResult` exists for the
**current head SHA**; CI green; zero `blocking` findings outstanding; every
acceptance criterion checked off; Definition of Done satisfied. In PR mode
(§3.10) the PR must also be open; with `pr.required: false` the pushed branch
is the review target.

---

## 11. Locks and crash recovery

`foreman:running` is a lock, and every lock needs a sweep for the case
where the process that took it died before releasing it. **One recovery
path, not a dedicated worker**: `foreman reconcile`'s invariant pass (§17.6)
runs the sweep as one of its checks, on the loop's cadence, and the
extension repeats the same check at `session_start` so a lock still clears
between loop runs or when no loop is running at all. Both read the same
lock comment through `readLockComment` / `verifyLockOwnership`
(`packages/core/src/lock.ts`) and classify it the same way (`LockState`).

**`foreman-plan` carries no lock.** `foreman:running` is an issue label, and
a bare project has no issue yet — the plan loop's own `InflightStore`
(§17.4), keyed by project id, is what stops a second `plan` dispatch from
racing the first before its issues land, not this mechanism.

- **The dispatcher's caller claims; agents never do.** The extension applies
  `foreman:running` *before* the spawn (§17.5) and releases it when the
  yield is consumed. The label is the mutex; the dispatch ID and timestamp
  ride in a machine-readable lock comment (`foreman:lock`,
  `packages/core/src/markers.ts`) written in the same mutation — a label
  can't carry them, and both the sweep and the agent's verify step need
  them. Release marks the comment released. Agents verify via
  `foreman_linear_read` that the live lock comment carries their dispatch ID
  (§7.3) and otherwise never write or clear anything. One owner, no claim
  race, and manual and loop dispatch share the code path.
- TTL derives from the runtime cap: 2× `task.maxRuntimeMs` plus margin — with
  the 2 h cap (§3.6), ~4–5 h. Long implementations are legitimate; a lock
  outliving twice the hard runtime cap is not.
- The sweep clears an expired lock whose dispatch ID is absent from the
  loop's own `InflightStore` (§17.4), posts what was found and when it was
  taken, and flags the worktree.
- **The sweep never deletes a worktree.** It reports; the operator decides.
  An automated delete that races a still-live agent loses work.
- **A lock on a terminal issue is released without raising a decision.** The
  sweep still strips `foreman:running` and still posts a comment recording
  what was found, but skips `foreman:blocked` and the Blocked queue
  (§4.2a) — there is no decision left to make about a lock on work that
  already finished or was abandoned.

---

## 12. Repo and worktree conventions

- One issue → one worktree → one branch → one PR — or one direct branch merge
  when `pr.required: false` (§3.10). No exceptions to the 1:1:1 shape.
- **Foreman owns worktree lifecycle**, not omp's isolation layer (§3.7). The
  repo is the instance's own working directory (§3.11).
- Worktree path: `../<repo>-<ISSUE-ID>` (e.g. `../plotroom-ENG-142`) —
  default, per-repo `worktreePattern` (§3.10).
- Branch: `<issue-id>-<kebab-slug>` (e.g. `eng-142-fix-triage-dedupe`) —
  default, per-repo `branchPattern`; base branch from `baseBranch` (§3.10).
- Worktrees are disposable but must survive a block. No state outside the
  worktree, Linear, and the PR.
- Cleanup of merged worktrees and their herdr tabs happens automatically once
  a merge is confirmed — reconcile's `merged-not-done` invariant (§17.6) and
  the operator-invoked `/foreman:merge` both call it right after moving the
  issue to Done. Gated by `loop.cleanupMergedWorktrees` (default `true`), and
  skipped — with a logged note, never an error — when the worktree still has
  uncommitted changes. Never runs for a crashed or orphaned lock; that stays
  the lock sweep's report-only territory (§11).

---

## 13. Artifact templates

Renderings of structured output, written into Linear by the extension (PR body
excepted — §13.2).

### 13.1 Issue description

```markdown
## Context
<why this exists; link to the Context doc section if relevant>

## Acceptance Criteria
- [ ] <observable behavior, verifiable by someone who didn't write it>

## Affected Areas
<from LSP, not guessed>

## Out of Scope
<explicit non-goals — prevents implement-time scope creep>

## Open Questions
<empty at Todo; anything here means it isn't refined>
```

Do not restate the Definition of Done here.

The extension owns every heading above. Each agent returns the parts — the
`## Context` prose in `description`/`refinedDescription`, and
`acceptanceCriteria`, `affectedAreas`, `outOfScope` as their own fields —
and one renderer assembles them, so the sections the parser reads back
(`acceptanceCriteria()`, `openQuestions()`) are always exactly the sections
that were written. `TriageItem.draftDescription` is the one exception: it is
stored verbatim, so it carries the full template.

### 13.2 PR body

Issue link, approach summary, checklist mirroring acceptance criteria, test
coverage note, Definition of Done checklist, and **Discovered work** from
`ImplementResult.discoveredWork`. The one artifact the extension does not
render: the PR must exist before yield (§7.3), so the implement agent authors
the body from the same data at creation — the mirror of its `foreman_github_pr`
exception to principle 9. The extension never rewrites it.

### 13.3 Spike issue

`type:spike`, a stated question, a stated budget, a **Deliverable** section
naming the artifact that ends the spike, and a native `blocks` relation to
whatever it unblocks. A spike with no written deliverable is unbilled wandering.

### 13.4 Review comment

Rendered from `ReviewResult`: the reviewed SHA, criteria verification with
evidence, Definition of Done checklist, findings grouped by severity, and the
standing project organization section.

---

## 14. Cadence

| Activity | Frequency | Actor | Effort |
|---|---|---|---|
| `foreman plan` (per repo) | Every `loop.pollSeconds` (default 20s) | Loop process | — |
| `foreman build` (per repo) | Every `loop.pollSeconds` | Loop process | — |
| Triage review (spot-check applied `TriageResult`s) | Daily | Operator | ~10 min |
| Blocked drain (`/foreman:status`) | 1–2× daily | Operator | ~15 min each |
| Prioritization / roadmap | Weekly | Operator | ~1 hour |
| Workflow retro | Every 2 weeks | Operator | ~30 min |

Refinement no longer has a cadence row — the loop dispatches it as soon as an
issue has a priority. That makes weekly prioritization the throttle on
everything downstream: nothing gets refined, implemented, or reviewed until the
operator sets a priority, which is exactly where the human judgment belongs.

Planning has no cadence row either, for the same reason: `foreman-plan` runs
inside `foreman plan` (§17.1), dispatched the moment a project is bare — not
on a schedule and not something the operator drains.

Retro tuning targets: avoidable blocks, refine outputs that led to bad
implementations, dedupe threshold, TTSR false-positive rate, schema validation
failures, review→fix cycles that hit the cap.

---

## 15. TTSR rules

Time Traveling Stream Rules sit dormant at zero context cost, match the output
stream, abort mid-token, inject the rule body, and retry from the same point.
Rules live in `rules/*.md`; frontmatter defines when and where to fire
(`condition`, `astCondition`, `scope`, `globs`, `interruptMode`), the body says
what to do instead. The filename becomes the rule name — discovery dedupes
first-wins, so a collision silently shadows.

With structured output doing most of the enforcement work (§6), TTSR is now the
backstop rather than the primary mechanism. Ship:

| Rule | Scope | Fires on | Injects |
|---|---|---|---|
| `foreman-no-interactive-questions` | `text` | Agent starting to ask the operator a question | Yield a `BlockRecord` instead |
| `foreman-no-scope-expansion` | `text` | "while I'm here", "also fixed", "took the opportunity to" | Criteria are the contract; file a new issue |
| `foreman-no-gate-bypass` | tool args | State transition without a validator call | Call the validator first |

**Run `omp ttsr scan` before enabling any of these.** Regex on prose is noisy,
and a false-positive rule that aborts every stream is worse than no rule.
Confirm effective sources with `omp ttsr list`.

**Still unverified:** whether TTSR rules propagate into subagent sessions. Test
with a throwaway rule in build step 2. If they don't propagate, the structured
`BlockRecord` union (§6) is doing the real work anyway — which is a good reason
to have built it that way.

---

## 16. Verified vs. assumed

**Verified against omp documentation:** project-plugin-root layout (lock file
plus a `node_modules` symlink, no manifest required) and the `omp.extensions`
manifest key and its silent-failure mode; user vs. project install scopes;
agent discovery precedence, case sensitivity, and `.omp`-roots-only scanning;
skill provider priorities; `tools` allowlist
semantics including forced `hub` and `exec` expansion; `spawns` granting the
`task` tool; `blocking` inline-vs-background execution and that no bundled agent
sets it; `output` / `schemaMode` precedence and strict validation; `advisor`
pairing and concern/blocker interrupts; `prewalk` cheap-model handoff at first
edit/write; `autoload-skills` loading named skills before the first assignment,
accepting CSV or a list, and silently ignoring unknown names; effort selector
behavior and `task.enableEffort` defaulting off;
forced `yolo` approval mode for child sessions; the `yield` termination
requirement and its three reminders; soft request budget, runtime cap,
concurrency semaphore, idle TTL and parking; registry states and `hub` revival;
isolation mode names, teardown, and non-revivable parking; branch mode's
`omp/task/<id>` naming; subagent lifecycle events; that child sessions don't
inherit history.

**Verified against herdr documentation:** client-server architecture with a
background server; panes and agents surviving client detach, terminal close, and
network loss; local and `--remote` SSH attachment; `omp` as a supported
`--kind`; `agent start` requiring an existing shell pane at its prompt and never
creating layout; `agent prompt --wait`, `agent wait --until`, `agent read`,
`agent send-keys`; the `working` / `idle` / `done` / `blocked` / `unknown` state
model and that `unknown` does not prove completion; `blocked` meaning a
recognized approval or question UI; `agent_not_idle` on history reads while
working; wait commands having no default timeout; agent name pattern and
uniqueness among live agents; creation commands returning JSON IDs; pane IDs
changing on `pane move`; pane and workspace metadata tokens with `--source`,
`--seq`, and `--ttl-ms`; plugins running unsandboxed as the invoking user;
the `HERDR_BIN_PATH` runtime variable.

**Assumptions to verify during build:**

1. **TTSR propagation into subagent sessions** (§15).
2. Whether plugin-provided `rules/` are discovered identically to project
   `.omp/rules/`.
3. Slash-command namespacing (`/foreman:triage` vs `/foreman:triage`). Hyphens
   are the safe choice.
4. Whether a pre-tool hook can hard-fail a call or only observe. If only
   observe, the `tools` allowlist is the sole enforcement.
5. Whether Linear can filter saved views on *incomplete* blocking relations
   (§4.10).
6. The bundled agent roster, which differs between doc versions. Doesn't affect
   the `foreman-` prefix rule but does affect what you can delegate to.
7. Whether Linear's GitHub integration auto-transition on merge fits the
   workflow (§4.2); if not, the loop gains a small merge-detection worker.
8. Frontmatter tool-name spellings (`search`, `dap`, `exec`) and whether
   `output: schemas/….json` resolves relative to the plugin root.
9. Whether documents attach at the initiative level on the current plan
   (§4.7). Fallback: the product `Context` doc lives pinned in the product's
   `Maintenance` project.
10. ~~Linear project↔team semantics for the ensure pass (§3.11): whether
    creating a project under an initiative requires an explicit team
    association, and whether issues can be queried by team + initiative
    efficiently enough for the 5-minute cadence.~~ **Resolved** — see §3.11 and
    `docs/VERIFIED.md` §16 item 10: project creation requires `teamIds`, and
    issue-by-initiative filtering is a single query through
    `NullableProjectFilter.initiatives`.

---

## 17. The loop

### 17.1 Two rule engines, not an orchestrator agent

The obvious move is a long-running "orchestrator" agent that watches the board
and decides what to run next. Don't build it. Every routing decision Foreman
makes is already a pure predicate over Linear state — the gate validators in
§10 *are* the routing table. Putting an LLM in that path pays model cost and
adds nondeterminism to something fully determined, and when it misroutes you
get to debug a prompt instead of reading a function.

`foreman plan` and `foreman build` are the two long-running CLIs (§3.1),
each a plain Node process running the same generic driver
(`packages/loop/src/engine.ts`) over its own `Loop<S>`:

```ts
interface Rule<S> {
  name: string;
  select(snapshot: S): Candidate[];   // pure — no network, no model call
}
interface Loop<S> {
  name: "plan" | "build";
  concurrency: number;                // loop.concurrency.{plan,build} (§3.10)
  fetch(ctx: LoopContext): Promise<S>; // the loop's only network read per poll
  rules: Rule<S>[];
  escalations?(snapshot: S, ctx: LoopContext): Escalation[];
}
```

`fetch` pulls one full snapshot of everything the loop's rules need; each
`Rule.select(snapshot)` then runs in-process over that snapshot and returns
its `Candidate[]` — no rule ever calls Linear itself, so all of a poll's
reads are paid for once, up front. `runLoop` offers every rule's candidates
once per poll, in rule order, applies the escalations below, dispatches
what the concurrency cap and each candidate's own retry state allow, and
sleeps until the next poll or until a running dispatch settles and frees a
slot — whichever comes first.

`foreman plan` runs `triage`, `plan`, and `refine` (§17.4); `foreman build`
runs `implement`, `review`, and `merge`. Splitting on this boundary, not one
process per transition, is why there are two CLIs and not six: refine's
candidates are cheap and Backlog-shaped, implement's are expensive and
worktree-shaped, and a single concurrency cap per loop is enough to shape
each mix without a per-rule sub-limit table.

### 17.2 Dispatchers

A rule decides *what* to run. How a spawn actually gets launched is a
separate, swappable concern behind a small interface
(`packages/core/src/dispatch/types.ts`):

```ts
interface Dispatcher {
  readonly kind: "print" | "herdr";
  dispatch(request: DispatchRequest): Promise<DispatchHandle[]>;
  status(handle: DispatchHandle): Promise<DispatchStatus>;
  settle(handle: DispatchHandle): Promise<DispatchOutcome>;
  cleanup?(issueId: string, repoPath: string, worktreePath: string | null): Promise<void>;
  available(): Promise<boolean>;
}
```

`DispatchStatus` is `"starting" | "running" | "settled" | "lost"`. A
`DispatchRequest` carries one candidate's `agent`, `command`, `cwd`, `alias`,
and a single-item `items[]` — the shape is array-typed because both
dispatchers accept a batch, but the current rules each offer exactly one
candidate per dispatch, so in practice it is always length 1.
`cleanup` is post-merge worktree housekeeping (§12): herdr closes the
issue's workspace when it had one, print mode leaves it unimplemented.

Two implementations, selected by `agent.dispatcher` (`"auto"` default,
preferring herdr when reachable):

- **Print** — `omp -p '/foreman:implement ENG-142'`. No dependencies, works
  headless anywhere, zero visibility while running. **Passes the
  approval-mode flag explicitly** (`agent.approvalMode`, default `yolo`) —
  the print-mode parent session is the same second interrupt surface
  described in §17.3, and left at defaults it can stall headless on its own
  tool calls.
- **Herdr** — a real terminal pane per agent, live state, and the ability to
  attach and take over. Requires the herdr server; `available()` reports
  false and the loop degrades to print mode when it isn't reachable.

### 17.3 The herdr dispatcher

Herdr is a terminal workspace manager with a background server: panes survive
client detach, laptop close, and network loss, and reattach locally or over
SSH. `omp` is a first-class agent kind, so `agent start … --kind omp` is
native rather than a shell hack. Given how much the loop runs unattended,
and how often you're reaching a machine over Tailscale rather than sitting
at it, this fits better than fire-and-forget print mode.

**The rule that makes it safe: herdr agent state is never a routing input.**

Herdr classifies agents as `working`, `idle`, `done`, `blocked`, or `unknown`
by recognizing patterns in terminal output. Its own docs are explicit that
`unknown` "does not prove successful completion." That is fine for directing
human attention and unacceptable as a source of truth for whether an issue
advanced. Linear state plus the validated structured output (§6) remain
authoritative for every dispatch decision. Herdr state drives the sidebar and
`/foreman:status` ordering — nothing else.

**Terminology collision, and a useful diagnostic.** Herdr's `blocked` means
it recognized an approval or question UI on screen. Foreman's `blocked`
means a `BlockRecord` was written to Linear. They are unrelated, and
conflating them will cost you an afternoon. Better: treat any herdr
`blocked` as a **Foreman bug**. The design says agents never ask questions
and never hit approval prompts, so a recognized approval UI means either the
parent session's approval mode wasn't configured or an agent found a path
around the block protocol. Surface it in `/foreman:status` as an anomaly,
not as a normal queue.

Set the dispatched session's approval mode explicitly (`agent.approvalMode`).
Subagents get forced `yolo`, but the *parent* session herdr launches is
interactive and can prompt on its own tool calls — a second interrupt
surface that bypasses `BlockRecord` entirely if left at defaults.

**Layout.** One workspace per repo alias; one pane per dispatched candidate,
named for its dispatch id (not its issue, so a redispatch before merge
cannot collide with the still-reserved name of the previous attempt) and
`--cwd`'d to the candidate's worktree when it has one, else the repo root.
There is no shared per-rule orchestrator session: every candidate — triage,
plan, refine, implement, or review — gets its own pane, because `engine.ts`
dispatches one candidate at a time (§17.1) and a session with no work left
to receive is nothing to share.

**Do not collect results by reading panes.** `agent read` returns
`agent_not_idle` while an agent is working, and alternate-screen history
reads are fragile. Foreman already has a better channel: the agent writes
structured output, the extension writes Linear, the loop reads Linear via
`settle()`. Pane reads are for the human looking at a stuck agent.

**Always pass a timeout.** Herdr wait commands have no default and will
block indefinitely. Pair every wait with `agent.maxRuntimeMs` on the omp
side so neither layer can hang forever.

**Worktrees stay Foreman's.** Herdr can create them; don't let it. Foreman
owns worktree lifecycle (§3.7, §12), and a terminal manager deciding branch
and checkout contracts is exactly the coupling to avoid.

### 17.4 Rules

```
foreman plan   rules: [triage, plan, refine]
foreman build  rules: [implement, review, merge]
```

Each rule owns one transition and evaluates only its own predicate over the
loop's already-fetched snapshot:

| Rule | Loop | Selects | Condition | Dispatches |
|---|---|---|---|---|
| `triage` | plan | Up to `loop.triageBatch` Inbox issues, batched into one candidate keyed on the whole batch | Inbox non-empty | `foreman-triage` |
| `plan` | plan | In-scope, non-Maintenance projects with zero issues | zero incomplete project blockers (§4.10a); a project with a status transition already terminal or bare-excluded never reaches the snapshot | `foreman-plan` |
| `refine` | plan | Backlog, plus Todo issues that fail the implementation gate (the label-free successor to the deleted `legacy` funnel, §4.9) | unassigned, no incomplete `blocked by` relations, non-terminal and non-paused project | `foreman-refine` |
| `implement` | build | Todo | unassigned, implementation gate passes (§10) | `foreman-implement` |
| `review` | build | In Review | PR (or pushed branch) open, no `ReviewResult` for the current head SHA, under `loop.reviewCycleCap` | `foreman-review` |
| `merge` | build | In Review | `loop.autoMerge` on, mergeable, review gate passes (§10, §17.6) | `/foreman:merge` |

**Dedup and concurrency are in-process, not a Linear label.** Every
`Candidate.key` (`issue:<ID>` or `project:<ID>`, or the sorted batch key for
triage) is checked against the loop's own `InflightStore` — a small JSON
file at `<stateDir>/<alias>/{plan,build}.json` — before a rule's candidate
is offered, so a project or issue already mid-dispatch is never offered
twice. `foreman:running` is a *separate*, Linear-visible lock the extension
claims when it actually spawns `foreman-implement` (§11) — the loop's own
`unlabeled()` filters on `refine`/`implement`/`review` already exclude
anything carrying it (or `foreman:blocked`/`foreman:hands-off`), so the two
mechanisms never disagree, they just operate at different layers: in-process
dedup for "is this loop already working it," the Linear label for "is any
process, including a manually-invoked one, working it."

**Concurrency is one global number per loop, not a sub-limit table.**
`loop.concurrency.plan` (default 1) and `loop.concurrency.build` (default 3)
cap `InflightStore.inFlightCount()`; when a loop is at cap, `offerCandidates`
skips every further candidate that poll rather than queueing them
separately per rule. Rule order therefore doubles as priority: `triage`
before `plan` before `refine`, `implement` before `review` before `merge`.

**Poll on `loop.pollSeconds`** (default 20s). Each poll re-fetches the whole
snapshot fresh; a settling dispatch also wakes the loop early so a freed
concurrency slot doesn't sit idle until the next scheduled poll.

### 17.5 Merge

`merge` is the one build-loop rule gated off by default:
`loop.autoMerge` (default `false`) keeps merge authority with the operator
unless explicitly turned on. When it is, the rule re-uses `reviewGate`
directly rather than re-deriving its checks — a refused `/foreman:merge`
exits 0, so a weaker precondition here would re-spawn a refused merge every
poll forever with no back-off. `/foreman:merge` itself is the same command
the operator would type by hand (§3.4); autonomy is entirely in whether the
loop decides to type it, never in a second merge implementation.

### 17.6 Retry, escalation, and reconcile

**Retry.** A dispatch that fails to launch, or whose `settle()` outcome is
non-`"settled"` or a non-zero exit code, increments a per-candidate failure
counter in `InflightStore`; a successful settle clears it. After
`loop.retryCap` (default 2) consecutive failures, `offerCandidates` stops
re-offering that candidate and, once per candidate, confirms and applies a
`retry-exhausted` escalation instead (below) — logging a "fix by hand"
notice for a non-issue candidate (e.g. a stuck `plan` project) that has
nothing to escalate to in Linear.

**Review-cycle escalation.** The build loop's `escalations()` hook scans
every In Review issue and flags any whose `request-changes` review count has
reached `loop.reviewCycleCap` (default 2) — a standing disagreement between
implement and review is operator information, not something to ping-pong
overnight (§7.4).

**`applyEscalation`** (`packages/loop/src/escalate.ts`) is the one place a
loop writes to Linear directly, because there is no agent output to
validate here — only the loop's own exhausted counter. It applies
`foreman:blocked`, clears `foreman:running` if held, clears the assignee,
and posts a `BlockRecord` block marker (`type: "needs-decision"`) naming
what was tried and recommending `re-scope the issue` over `fix by hand`.
Both loop modes confirm this through the same `Confirmer` (§17.7) every
other Linear write goes through — declining leaves the issue un-escalated
and the loop simply retries it again next poll, no state lost.

**`foreman reconcile`** is a separate, short-lived CLI — not a loop rule —
run on its own cadence (a `launchd`/`systemd` timer, or by hand) that sweeps
invariants no poll-scoped rule is positioned to catch: orphaned
`foreman:running` locks past their TTL (§11), a merged issue never moved to
Done, and native project status left stale (§7.6a). It shares `core`'s
validators with both loops and the extension, so a lock or a stale status it
finds is judged by the identical logic that would have caught it live.

### 17.7 Autonomy

There are exactly two loop modes, `loop.mode`: `confirm` (the default) and
`yolo`.

`confirm` asks the operator, on the loop's own terminal, before every action
that changes state *outside the loop process*: every agent dispatch
(`Confirmer.confirm({ kind: "dispatch-plan" | "dispatch-build" })`) and every
direct Linear write the loop itself makes — currently only escalation
(`kind: "linear-write"`). Reads are never gated — the loop still evaluates
every rule and still logs its intent either way. The loop's own
`InflightStore` writes are not gated either; that file is how the process
remembers what it already dispatched, so prompting for it would make
`confirm` mode unable to keep books rather than more careful.

Declining is how you get a dry run: the loop still evaluates, still logs its
intent, and simply does not dispatch or write. There is no separate
dry-run flag, because answering "no" to everything is the same thing, and it
lets you say yes to the one dispatch you did want.

Merge authority is `loop.autoMerge` (§17.5), off by default regardless of
`loop.mode` — a `yolo` loop still leaves merging to the operator unless
`autoMerge` is separately turned on.

`loop.mode: "yolo"` and `agent.approvalMode: "yolo"` are different settings
at different layers and neither implies the other. `loop.mode` governs
whether the loop asks *its* operator before dispatching or writing to
Linear. `agent.approvalMode` is the omp approval mode each dispatched
session itself runs under, once dispatched. A `confirm`-mode loop can still
dispatch agents that run with `approvalMode: "yolo"` inside their own
sessions, and a `yolo`-mode loop can dispatch agents pinned to a stricter
`approvalMode`.

---

## 18. Build order

1. **Plugin skeleton + Linear config.** Correct `omp.extensions` key, the
   two-file per-repo activation, `/reload-plugins` loop working. The `core` config
   loader with schema validation, layering, and defaults (§3.10). Workspace
   topology per §4.0: single team, default issue template → Triage,
   initiatives enabled, one initiative per product (grouping prefixes where
   wanted), the `repos` registry populated and the ensure pass
   creating `Maintenance` projects (§3.10, §3.11). Then Linear
   states, the `foreman:` and `type:` label groups, six saved views, one
   worked product `Context` doc + project brief with a Definition of Done.
   Resolve §16 items 5, 7, and 9. ~1 day.
2. **Schemas + extension core + interrupt protocol.** The five result schemas
   and `BlockRecord` union first — everything downstream consumes them. Then
   typed Linear read tools, the result-application layer that makes the
   extension the sole Linear writer (principle 9), gate validators, the lock
   manager (dispatch IDs, claim/release), the config loader's
   `session_start` validation, scope check, and ensure pass (§3.10, §3.11),
   lifecycle listeners, `foreman-block-protocol` skill, the skill-name
   resolution guard (§8), and `/foreman:status`. Verify §16 items 1 and 2
   here. ~2 days. Build before any agent — retrofitted, one agent gets a
   "just ask the user" fallback and it becomes the default.
3. **`foreman-triage`, applying directly.** `foreman plan`'s `triage` rule
   (§17.4): registry-derived repo lookup, `TriageResult` applied through the
   same result-application layer as every other agent. ~1 day. **Run it for
   a week before building anything else.** Its classification and dedupe
   calls teach more about where the operator's judgment lives than
   designing the rest up front.
4. **`foreman-refine` + `foreman-spike`.** After triage tuning, still inside
   `foreman plan`'s `refine` rule. ~half a day.
5. **`foreman-implement` + `foreman-review` + the fix cycle + TTSR rules.**
   Shaped by what 3 and 4 revealed. Includes the resume-mode path in the
   implement skill, the findings route with its cycle cap (§7.4), and
   `/foreman:merge` (§3.10) as a plain command — `loop.autoMerge` and the
   `merge` rule come in step 6. ~1.5 days, most of it in worktree lifecycle
   and the fix cycle.
6. **`foreman plan` + `foreman build` + `PrintDispatcher` + autonomy
   (§17.7).** The two loop CLIs over the shared rule engine (§17.1), each
   with its own concurrency cap, `InflightStore`, retry cap, and
   `Confirmer`/`--mode`. Prove `foreman build` single-instance on the
   `implement` rule alone before adding `review` and `merge`; prove
   `foreman plan` on `refine` alone before adding `plan` and `triage` —
   introducing every rule in one loop together makes a routing bug
   impossible to attribute. ~1.5 days. Then run a week in `confirm` mode
   before switching to `yolo`.
7. **`foreman reconcile` + `HerdrDispatcher` (optional).** The invariant
   sweep (§17.6): orphaned locks, merged-not-Done, stale project status.
   Then herdr layout, agent naming, sidebar tokens, attach path, print-mode
   fallback. ~1 day combined. Only after step 6 is boring.

Roughly 9 focused days of build, spread across several weeks of observation
windows. The waiting is the point; compressing it is how you end up with a loop
that dispatches confidently into a routing bug.

---

## 19. Non-goals

- Auto-merge unattended by default — `loop.autoMerge` is off unless the
  operator turns it on (§17.5)
- An orchestrator *agent* — routing is a pure function (§17.1)
- Agents holding Linear or GitHub write tools (implement's `foreman_github_pr`
  excepted) — the extension is the sole writer (principle 9)
- An uncapped review→fix cycle (§7.4, §17.6)
- A loop that dispatches past its concurrency cap (§17.4)
- Herdr agent state as a routing input (§17.3)
- Herdr-managed worktrees — Foreman owns worktree lifecycle
- Collecting agent results by reading terminal panes
- Herdr as a hard dependency — print mode must remain a working fallback
- Linear webhooks in the first build — polling is sufficient
- A separate severity axis alongside Priority
- Dependency modeling via labels
- `isolated: true` on any Foreman agent
- `spawns: true` on any Foreman agent
- Velocity, burndown, or points-completed metrics
- Cross-agent messaging as a design element — `hub` is a live-process
  optimization for revival and the review fix cycle (§9); Linear is the
  message bus
- A control-plane socket or `patchConfig` RPC for a running loop — restart
  the process to pick up a config change
- A second intake process — the Triage inbox has exactly one consumer,
  `foreman plan`'s `triage` rule (§17.4)
- A central daemon watching all of Linear — the instance model (§3.11) is
  per-repo by design
- An `area:` ontology beyond what `foreman-implement` reads
- A public plugin marketplace; the design has no marketplace or distribution
  channel beyond the single global symlink `foreman setup` writes
- Config keys that can disable gates, the lock protocol, or the loop's
  retry cap — config tunes parameters, never removes invariants (§3.10)
