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
6. **Propose before apply** for bulk mutation.
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
    loop/                       # `foreman repo` + `foreman team` CLIs (§3.11, §3.12)
```

The omp plugin is a Claude/OMP-compatible plugin directory. It is **always
installed project-scoped**, into the specific repo `foreman init` registers —
never user-scoped. A user-scoped install would put Foreman's agents, skills,
TTSR rules, and slash commands into every omp session on the machine,
including repos that never use Foreman; Foreman is per-repo by construction —
the `repos` registry (§3.10) binds specific repos — so machine-wide is never
the right scope. It is also the only scope omp's CLI can reach: `--scope` is
honored for a marketplace install (`name@marketplace`) alone, while `omp
plugin link <dir>` and installs from a local path are unconditionally
user-wide regardless of any flag passed.

Every managed repo therefore runs the *published* plugin. Foreman's own
checkout is the one exception: `foreman init` detects that it is registering
the tree that owns `packages/omp-plugin` and repoints the installed symlink
at the working copy, so plugin development does not need a publish
round-trip per edit. That is a direct rewrite of omp's install layout rather
than an omp command, for the reason above — see `packages/cli/src/plugin-link.ts`.
`/reload-plugins` applies Markdown changes (agents, skills, commands, rules)
without a restart either way; a changed extension needs `bun run build`.

**`foreman update` — the machine-refresh contract.** After Foreman changes
land on GitHub, `foreman update` is the only supported way to bring a
machine current; a hand-rolled `omp plugin marketplace update` or `git pull`
is not equivalent and MUST NOT be recommended in its place. It runs, in this
fixed order: (1) pull the Foreman checkout (`git pull --ff-only`, skippable
with `--skip-pull`); (2) rebuild it (`bun install && bun run build`); (3)
refresh the omp marketplace catalog (`omp plugin marketplace update
foreman`); (4) upgrade the omp plugin (`omp plugin upgrade foreman@foreman`)
in every repo listed in the `repos` registry (§3.10) that has it installed,
skippable entirely with `--skip-plugin`. Steps 3 and 4 MUST run in that
order and MUST NOT be reordered or split across separate invocations,
because `omp plugin upgrade` never fetches from GitHub — it only re-copies
the marketplace clone already on disk, so upgrading before the marketplace
refresh silently reinstalls stale content. Step 2 MUST precede any use of
the `foreman` binary the pull produced, because the installed `foreman`
command is a symlink to `packages/cli/dist/main.js`; a pull without a
rebuild leaves the operator running the previous build under the new
source. Step 4 MUST run against every registered repo in the same pass, not
just the repo the operator happens to be standing in: the plugin cache is
version-keyed (`~/.omp/plugins/cache/plugins/foreman___foreman___<version>`),
every repo's project-scoped install is a symlink into that one shared
directory, and upgrading a single repo past a version bump deletes the
superseded cache directory — stranding every other registered repo's
symlink. `foreman update` treats a marketplace-refresh failure as fatal to
the whole run (it stops before touching any repo, per the invariant above)
and treats each repo's plugin upgrade as independently best-effort, so one
repo missing project scope or failing to upgrade does not block the rest.

Everything below `packages/omp-plugin/` except `package.json` and `src/` is
*auto-discovered by convention*: omp scans an installed plugin tree for
`agents/`, `commands/`, `skills/`, `rules/`, `prompts/`, `hooks/`, `tools/`,
and `.mcp.json` with no manifest entry naming any of them. Only the extension
module has to be declared.

```
packages/omp-plugin/
  .omp-plugin/plugin.json       # omp-native manifest (Claude's is .claude-plugin/)
  package.json                  # omp.extensions declaration — the ONLY declared path
  agents/                       # auto-discovered (§3.2)
    foreman-triage.md  foreman-refine.md  foreman-plan.md
    foreman-implement.md  foreman-review.md
  skills/                       # auto-discovered (§3.3); dir name is the skill name
    foreman-triage-inbox/SKILL.md   foreman-refine-issue/SKILL.md
    foreman-plan-project/SKILL.md   foreman-implement-issue/SKILL.md
    foreman-review-diff/SKILL.md    foreman-spike/SKILL.md
    foreman-block-protocol/SKILL.md
  commands/                     # auto-discovered; one per agent dispatch, `$1`-substituted
    triage.md  refine.md  plan.md  implement.md  review.md
  rules/                        # auto-discovered (§15)
    foreman-no-interactive-questions.md
    foreman-no-scope-expansion.md
    foreman-no-gate-bypass.md
  schemas/                      # JSON Schema for each agent's output (§6)
  scripts/check-contract.ts     # the enforcement-surface guard (§3.13)
  src/
    extension.ts                # the declared entrypoint's source
    tools/                      # foreman_linear_read, foreman_github_pr
    render/                     # Linear comment and issue-body rendering (§3.1.1)
    enforce/  lock/  results/  commands/
  dist/
    extension.js                # COMMITTED build artifact — see below
```

`/foreman:status`, `/foreman:apply`, `/foreman:merge`, and `/foreman:unblock`
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

**The bundle is committed, and that is load-bearing.** `omp plugin install`
copies this package out of a git clone of the marketplace repo and never runs a
package manager, so a gitignored `dist/` means the declared entrypoint is simply
absent — omp includes a declared entry only if the file exists, and drops a
missing one silently. The auto-discovered markdown above still loads from the
copied tree, so `/foreman:plan` expands normally while both tools, the task
guard, the lock manager, and the result appliers are all missing. CI rebuilds
and fails on drift; `check-contract.ts` fails when the entrypoint is missing.

**Bundling is not an omp requirement — it is a requirement of *this* package.**
omp runs TypeScript directly, a `.ts` entrypoint loads fine, and an extension
may import genuine runtime dependencies from its own `node_modules`. Exactly
one reason is load-bearing:

**The installed copy has no dependencies and cannot get any.** A marketplace
install copies `packages/omp-plugin/` out of a git clone, symlinks it into the
scope's `node_modules`, and runs no package manager — the installed tree has no
`node_modules` at all. The plugin's sole dependency is `@foreman/core`, which
is `private: true` and specified `workspace:*`: unpublishable to a registry and
unresolvable by any package manager outside this monorepo. Bundling inlines it,
so the shipped extension resolves nothing at runtime.

Everything else about TypeBox is downstream of that and changes no decision.
omp remaps an extension's bare `@sinclair/typebox` import to its
`@oh-my-pi/omptype` facade, which rejects `default: {}` — `config/schema.ts`
carries eleven of them. This never fires in the shipped plugin, because
bundling resolves the specifier at build time. It is also escapable if it ever
matters: the filter is `/^(?:@sinclair\/typebox|typebox)$/`, so the subpath
`@sinclair/typebox/type` exports the same `Type` builder and reaches real
TypeBox untouched.

**Core must not adopt omp's TypeBox**, which is otherwise the obvious
simplification. `packages/cli` ships the standalone `foreman` binary, depends
on core, and has no omp dependency — `foreman init` is what installs the omp
plugin in the first place, so it necessarily runs before omp's runtime exists
in a repo. Routing core's schemas through `@oh-my-pi/omptype` would make the
tool that bootstraps omp depend on omp's internals to read
`~/.foreman/config.json`. The two libraries also disagree on semantics that
§3.10's sparse-override design rests on: omptype validates a default as an
instance of its schema, while TypeBox treats `default` as inert annotation that
`Value.Default` later applies.

```json
{
  "omp": {
    "name": "foreman",
    "description": "Agile SDLC workflow over Linear",
    "extensions": ["./dist/extension.js"]
  }
}
```

Plugin names: lowercase alphanumeric, hyphens and dots, start and end
alphanumeric, ≤64 chars. `foreman` is valid; underscores and capitals are not.

#### 3.1.1 What `@foreman/core` is for

Core exists because two independent writers mutate the same Linear workspace:
the omp plugin (operator commands and agent dispatches) and the loop supervisor
(autonomous). A duplicated filter or label constant means the two disagree
about whether an issue is Ready, and both claim it. Core is that shared state
contract, not a general utility bin.

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

`control/` looks lopsided (21 loop identifiers against 4 from the plugin) but
belongs here for the same reason: it *is* the wire protocol, with the loop
calling `writeStatusFile` and the plugin calling `readStatusFile`. One writer,
one reader, one definition.

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
| `/foreman:triage` | `foreman-triage` over the Inbox view | none |
| `/foreman:refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman:implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` | `<ISSUE-ID>` or PR |
| `/foreman:apply` | no agent — the extension applies approved proposals directly (§7.1) | none |
| `/foreman:merge` | no agent — the extension merges via the configured strategy once the review gate passes (§3.10) | `<ISSUE-ID>` |
| `/foreman:unblock` | no agent — records the operator's reply and clears the block; the loop dispatches the resume (§9) | `<ISSUE-ID>` |
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
3. **Lock manager.** Writes `agent:running` + dispatch ID + timestamp before
   every spawn and releases it after the yield is consumed. Agents never touch
   the lock (§11).
4. **Lock reaper** (§11).
5. **Structured-output consumers.** Read `structuredOutput.data` off each
   `SingleResult` and drive every Linear mutation from validated objects —
   descriptions, labels, state moves, sub-issue and spike creation, discovered
   work, comments, review renderings. This is where principle 9 lives.
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
   Use them to keep `/foreman:status` live and to detect aborts.
8. **GitHub read client.** Extension-internal, like the Linear write client:
   fetches PR diffs and head SHAs for review dispatch (§7.4) and checks CI
   status for the review gate (§10). Never exposed as an agent tool.

### 3.6 Budgets — use the native ones

omp already implements everything §3.5 would otherwise hand-roll. Configure
rather than reimplement:

| Setting | Default | Foreman use |
|---|---|---|
| `task.softRequestBudget` | 200 requests | Per-agent ceiling. Crossing it injects a wrap-up notice; at 1.5× the run is force-stopped and yields partial findings. |
| `task.maxRuntimeMs` | 0 (off) | **Set it — 2 h.** An implement agent that runs six hours is stuck, not thorough. The lock reaper TTL derives from this (§11). |
| `task.maxConcurrency` | — | Bounds fan-out across parallel spawns; resized live. |
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

omp has no built-in scheduler. Run the daily triage pass with cron or launchd
invoking print mode (`omp -p`) against `/foreman:triage` — superseded by
`foreman team` once §3.12 exists. Do not run both.

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
consumers the same lookup — instances resolve their scope from it by cwd, and
intake inverts it in memory for initiative→repo without any filesystem
scanning. Per-repo settings deep-merge over `repoDefaults`, entry wins. The
trade-off is accepted deliberately: repo settings no longer travel with a
clone, which matters for teams and not for one operator — and the file itself
can live in the dotfiles repo like any other machine config. `foreman init`,
run once per repo inside that repo, is the command that produces one `repos`
entry **and** installs the omp plugin project-scoped into that repo (§3.1);
`foreman setup` never runs global setup and never touches this table — it
installs no plugin at all, only the marketplace catalog the later `init`
installs from.

The registry key is named `repos`, not `projects` — in this document
"project" means a Linear milestone (§4.1), and overloading it for repo
entries would guarantee confusion.

Sketch (defaults shown; every number quoted elsewhere in this spec is a
default defined here, not a constant):

```jsonc
{
  "loop": {
    "wipGlobal": 3,                                       // §17.6
    "wip": { "refine": 2, "implement": 3, "review": 2, "plan": 1 },
    "readyBufferTarget": 5,                               // §17.6
    "backpressureThreshold": 5,                           // §17.7
    "retryCap": 2,                                        // §17.8
    "reviewCycleCap": 2,                                  // §7.4
    "cadenceMinutes": 5,
    "mode": "confirm",                                    // §17.9 — ask before every dispatch and every Linear write; "yolo" acts unattended
    "workerModes": {},                                    // §17.9 — per-worker override; a missing key inherits loop.mode
    "mergeDetection": true,                               // §16 item 7 — required (not optional) when repoDefaults.pr.required is false
    "stateDir": "~/.foreman/state"
  },
  "intake": {                                             // §3.12 — team-level process
    "window": "06:00",
    "staleLowDays": 90,                                   // §7.1
    "batchSize": 20,
    "timezone": "<host IANA zone>"                        // resolved at load time, e.g. "America/Los_Angeles"
  },

  "linear": {
    "apiKeyEnv": "LINEAR_API_KEY",                        // checked first
    "apiKeyFile": null,                                   // checked when the env var is unset
    "endpoint": "https://api.linear.app/graphql"
  },

  "agent": {
    "maxRuntimeMs": 7200000,                              // §11 — mirrors omp's own task.maxRuntimeMs; the lock TTL derives from this
    "lockTtlMarginMs": 1800000,                           // lock TTL is 2 × maxRuntimeMs + this (~4.5h by default)
    "ompBin": "omp",
    "approvalMode": "yolo",                               // §17.2, §17.3 — always-ask | write | yolo, passed to every dispatched parent session
    "herdrBin": "herdr"
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
    "plotroom": {                                         // alias: positional arg to `foreman repo`, herdr workspace name, state dir
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

Registry validation the split files couldn't do: an initiative bound in two
`repos` entries is now a config error caught at load, not a runtime surprise
— previously no single instance could see the collision.

**`pr.required: false` — direct-branch mode.** The workflow shape is unchanged
(one issue → one worktree → one branch), but implement pushes the branch and
opens no PR (`prUrl` stays empty in the `ImplementResult`), review diffs
`baseBranch..head` fetched by the extension (§7.4), the review gate targets the
pushed branch (§10), and Done cannot come from Linear's GitHub PR integration —
the merge-detection worker (§16 item 7) becomes **required** in this mode, not
optional.

**`/foreman:merge <ISSUE-ID>`.** Operator-invoked, never loop-invoked — this
does not weaken the no-auto-merge non-goal (§19). The extension checks the
review gate, then merges with the configured strategy (`gh pr merge` in PR
mode, a local merge of the branch onto `baseBranch` in direct mode) and
deletes the branch if configured. One command, both modes, gate-checked
either way.

**Config tunes parameters, never removes invariants.** There is no key that
disables a gate, the WIP limit, backpressure, the lock protocol, or
propose-before-apply. `backpressureThreshold: 0` means "no new dispatches
while anything is blocked," not "off." Validation rejects unknown keys — a
typo that silently falls back to a default is the config-file equivalent of
the `autoload-skills` silent-ignore trap (§8).

Reload semantics: the extension reads config at `session_start`; the loop
re-reads at the top of every cadence tick, so tuning WIP or backpressure does
not require a loop restart.

### 3.11 Instance model — one Foreman per repo

Foreman runs **in a repo, for that repo's initiatives**. There is no central
daemon watching all of Linear; the unit of deployment is an instance launched
in a working directory (normally a repo root), scoped to a team plus the
initiatives bound to that repo in the global `repos` registry (§3.10). A
monorepo binds several initiatives — the `plotroom` entry binds
`Plotroom Fleet` and `Plotroom Zero`.

**Invocation.** `foreman repo [alias] [--team <KEY>]`, run in the
repo. The instance's registry entry resolves by matching cwd (symlinks
resolved) against entry paths; the positional alias overrides, and an unregistered
directory fails loudly naming the fix (add an entry). Team resolution:
`--team` flag → the entry's `team` → the sole team the credential can access
→ fail loudly. Manual slash commands resolve the same way from the session's
cwd.

**Scope predicate.** An issue is in scope iff it belongs to the team AND its
project's initiative is in this instance's bound set. The loop silently skips
out-of-scope issues (they belong to another instance); a manual command
against an out-of-scope issue refuses with the reason, never guesses.

**Ensure pass.** On instance start (and extension `session_start`): verify
each bound initiative exists and has its standing `Maintenance` project,
creating that project — team-assigned, since Linear's `ProjectCreateInput`
requires `teamIds` and has no `initiativeId` — if missing. Attaching the new
project to the initiative is a second mutation, `initiativeToProjectCreate`,
run after creation succeeds. Milestone projects enter through intake
proposals the operator approves (§3.12); the ensure pass itself auto-creates
only `Maintenance`.

**Concurrent instances are already safe.** The mutex is in Linear, not in any
process: claim-before-dispatch (§11, §17.5) prevents double-work even if two
instances' scopes overlap. The per-repo lockfile (§17.5) prevents two
instances *of the same repo*; nothing else needs coordinating.

**Triage is not part of the per-repo loop.** The shared team inbox is
consumed by the single team-level intake process (§3.12); repo instances run
refine, implement, and review only. One consumer, no scope negotiation, no
proposal races.

**Shared human, shared tripwire.** WIP limits are per-instance (§17.6);
backpressure is **team-wide** (§17.7) — the blocked and proposal counts are
queried across the whole team, so five instances still throttle against the
one operator's actual drain rate, with Linear as the only coordination point.

**Per-instance state.** The loop lockfile and bookkeeping file (§17.5) live
in `~/.foreman/state/<repo-alias>/` — with no per-repo config directory,
state is global too, keyed by the registry alias.

### 3.12 Intake — the team-level triage process

One process for the whole team, separate from the per-repo loops:
`foreman team`. The shared Triage inbox is a single queue, and a single consumer
is strictly simpler than N repo-scoped loops negotiating over it.

**What it does.** The operator files rough material into the inbox — a
two-line bug, a one-line idea, naming the initiative it belongs to. On its
window, intake dispatches `foreman-triage` (§7.1), which turns each item into
a finished **draft**: bug- and task-sized items become fully drafted issues
(§13.1 shape, proposed priority and estimate) destined for a project under
that initiative; idea-sized items become **proposed milestone projects** —
name, project brief (§4.7), optional seed issues. Everything is
proposal-grade until approved: the point of intake is that approval becomes a
yes/no on finished work, not a prompt to go write it yourself. Nothing —
especially not a project — is created unapproved.

**Intake drafts; refine stamps.** Intake works from the ticket, the Context
docs, and light repo reads. `foreman-refine` (§7.2) still runs after the
operator prioritizes: it verifies the draft against the code via LSP,
finalizes the estimate, and applies `agent:ready`. This keeps the priority
throttle intact — intake fleshes out everything in the inbox, but nothing is
repo-verified and dispatched until prioritized.

**Repo lookup.** Intake is team-level and repro/context reads need repos —
which is exactly what the global registry (§3.10) provides: intake inverts
`repos` in memory for initiative→repo, no filesystem scanning, no refresh
interval. An initiative bound to no registry entry still gets classified and
drafted — just without repro, flagged in the proposal.

**Process shape.** A singleton with a lockfile in `~/.foreman/state/intake/`,
run from cron/launchd or a herdr pane in the
`foreman` workspace (§17.3). Respects team-wide proposal backpressure
(§17.7). The apply pass (§7.1) also runs here on every tick, so approvals are
picked up without a manual `/foreman:apply`.

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
| `Backlog` | Accepted, not yet refined. | extension, from `TriageProposal` |
| `Todo` | **Refined and ready.** Gate §10 satisfied. | extension, from `RefineResult`; also on block, In Progress → Todo (§9) |
| `In Progress` | Worktree open, code being written. | extension, at implement dispatch |
| `In Review` | PR open, awaiting review. | extension, from `ImplementResult` |
| `Done` | Merged. | Linear's GitHub integration on merge (PR mode); the loop's merge-detection worker when `pr.required: false` (§3.10). The operator does the merging, via `/foreman:merge` or by hand |
| `Canceled` | Won't do. | extension (approved proposal) or operator |
| `Duplicate` | Merged into another issue. | extension (approved proposal) or operator |

Treat "Todo" and "Refined" as synonyms.

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

**`agent:` ⊕** — lifecycle control, written only by the Foreman extension.

| Label | Meaning |
|---|---|
| `agent:ready` | Cleared for pickup by `foreman-implement`. |
| `agent:running` | An agent holds this issue. Acts as a lock (§11). |
| `agent:proposed` | Unapproved agent proposal present. |
| `agent:hands-off` | Agents must never touch this. Operator escape hatch. |

**`blocked:` ⊕** — the human interrupt queue. Only for blocks with no issue to
link. `blocked:needs-input`, `blocked:needs-decision`, `blocked:external`.

**`legacy`** — amnesty marker (§4.9).

**`triage:` ⊕ (optional)** — `triage:cannot-reproduce`, `triage:duplicate`,
`triage:needs-info`, `triage:wont-fix`.

**`area:` (optional)** — derive from the repo's real structure at build time.
Build only if `foreman-implement` uses them to scope initial reads.

> `type:`, `agent:`, `blocked:`, and `legacy` are load-bearing. The rest are
> optional.

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

### 4.9 Legacy amnesty

Issues predating Foreman have no template, no estimate, no priority — and may
sit in any state, including Todo. Apply `legacy` to all pre-existing issues at
install time. The label means "unrefined, regardless of state": it never
bypasses a gate — a `legacy` issue in Todo still fails the implementation gate
(no `agent:ready`, no criteria) and cannot be dispatched. Instead, the refine
worker treats `legacy` issues in Backlog *or* Todo as its input (§17.5), and
`foreman-refine` strips the label when it processes one. Priority remains the
throttle: an unprioritized legacy issue waits like any other. Without the
label, day one is a wall of gate failures with no funnel back to refinement.
Preferred over a cutoff date, which strands issues you actually want. The
amnesty pass is also when projectless pre-existing issues get homed — default
destination the product's `Maintenance` project — since the refinement gate
requires project membership (§10).

### 4.10 Required saved views

1. **Inbox** — state = Triage
2. **Blocked (human)** — any `blocked:*` label
3. **Blocked (deps)** — incomplete `blocked by` relation
4. **Proposals** — `agent:proposed`
5. **Ready** — Todo AND `agent:ready` AND estimate set AND priority ≠ None
6. **In flight** — `agent:running`

**Verify during build:** Linear can filter on relation *existence*; whether it
can filter on *incomplete* blockers specifically is unconfirmed. If it can't,
keep views 2 and 3 separate rather than contorting a compound filter — a filter
that silently under-reports costs a stalled issue; two views cost nothing.

---

## 5. Subagent frontmatter contract

Frontmatter sets the contract; the body is the system prompt. These fields are
the enforcement surface — everything expressible here must be here rather than
in prose.

| Field | Behavior | Foreman policy |
|---|---|---|
| `tools` | Explicit allowlist. `hub` is force-added regardless. `exec` expands to `eval` + `bash`. `task` is auto-added if `spawns` is set. | The security boundary. Enumerate per agent (§7). No agent gets any Linear or GitHub mutation tool except implement's `foreman_github_pr` (principle 9). |
| `spawns` | Grants the child the `task` tool so it can fan out further. | **`false` on all five.** Recursive fan-out inside a workflow agent is exactly the uncontrolled behavior Foreman exists to prevent. Set explicitly; do not rely on the depth gate. |
| `blocking` | `true` runs the spawn inline; default is a background job whose result is delivered into the parent conversation later. No bundled agent sets it. | `true` only for `foreman-refine` (short-lived; inline is right both when the operator invokes it and in the loop's print-mode parent). Everything else background. |
| `thinking-level` | The agent's effort selector. `auto` does per-prompt classification. Per-spawn `effort` overrides it, but only when `task.enableEffort=true` (default off) — so in practice frontmatter is the real control. | Per agent, §7. Don't rely on `effort` unless you enable the setting. |
| `output` | JSON Schema for structured output. Precedence: per-call `outputSchema` → frontmatter `output` → inherited parent schema. Pair with `schemaMode: strict`. | **Required on all five.** See §6. |
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

Set `schemaMode: strict` on all five. Permissive mode defeats the purpose.

With principle 9, these objects are not just the return channel — they are the
*complete* specification of every mutation the extension applies. Anything an
agent wants changed in Linear must be expressible in its result schema, or it
doesn't happen.

Sketch schemas — refine during build, but keep the shapes:

```
TriageProposal
  items[]: { issueId, type, proposedPriority, severityReasoning,
             duplicateOf?, proposedBlockedBy[], reproConfidence,
             missingInfo[], draftDescription, proposedEstimate?,
             destination: existingProjectId
                        | newProject { initiativeId, name, brief,
                                       seedIssues[] } }
  summary

PlanResult
  projectId, proposedIssues[]: { title, type, description,
             acceptanceCriteria[], proposedPriority, proposedEstimate? },
  outOfScope[], fullyPlanned, rationale

RefineResult
  issueId, refinedDescription, estimate, acceptanceCriteria[],
  affectedAreas[], outOfScope[], subIssues[], spikeCreated?,
  readyForImplementation

ImplementResult
  issueId, branch, prUrl?, criteriaMet[], testsAdded[],
  discoveredWork[]

ReviewResult
  issueId, reviewedSha,
  criteriaVerification[]: { criterion, satisfied, evidence },
  dodSatisfied, findings[]: { severity, file, line, description },
  projectOrganization, verdict
```

Plus a `BlockRecord` any agent may return **instead of** its normal result:

```
BlockRecord
  blocked: true, type, whatIWasDoing, whatINeed,
  options[]?, recommendation?, stateLeftBehind, costOfWrongGuess
```

A union of the normal result and `BlockRecord` is what each `output` schema
declares. The extension branches on `blocked` — that is the whole interrupt
protocol reduced to a discriminated union, which is far more reliable than
regex-matching a markdown heading.

The Markdown artifacts in §13 are still produced, but as *renderings* of the
structured data written into Linear, not as the agent's return channel.

---

## 7. Agents

### 7.1 `foreman-triage`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: false
model: "@default"
advisor: off
prewalk: false
autoload-skills: [foreman-triage-inbox, foreman-block-protocol]
output: schemas/triage-proposal.json
schemaMode: strict
```

| | |
|---|---|
| **Transition** | `Triage → Backlog / Canceled / Duplicate`, or a proposed new project (§3.12) |
| **Trigger** | The intake process (§3.12). Never called mid-flow by another agent. |
| **Model role** | default — drafting project briefs and full descriptions outgrew `smol` |

No Linear mutation surface of any kind, no `edit`, no `write`, no `bash`.
Read-only by construction. Scope is the whole team inbox (§3.12); repro and
context reads resolve repos through the registry index intake inverts from
`repos` (§3.10) — no filesystem scanning.

**Per item:** classify (`type:`), dedupe by semantic similarity, attempt repro
*by reading only*, propose a Priority with severity reasoning, flag missing
information, propose native `blocked by` relations, and **draft the artifact**
(§3.12): a full §13.1-shape description with a proposed estimate, destined for
an existing project (a milestone or the product's standing `Maintenance`
project, §4.0) — or, for idea-sized items, a proposed new milestone project
with its brief and optional seed issues.

**Output:** a `TriageProposal`. The extension writes one comment per item — the
human rendering plus an embedded machine-readable copy of the item — and
applies `agent:proposed`. Nothing else is applied. Operator approves by removing
`agent:proposed`, rejects with `reject: <reason>`.

**Applying approvals is not an agent job.** An approved `TriageProposal` item
already says exactly what to do — applying it is deterministic, so
`/foreman:apply` is extension code, not a re-dispatch of the agent. It queries
issues whose latest Foreman proposal comment has no `agent:proposed` label, no
`reject:` reply, and no later applied-marker comment, and applies each; on
success it writes the applied marker. Everything it needs lives in the comment,
so approval state is derivable from Linear alone — no second store to lose.
(It cannot be an agent anyway: tool allowlists are static frontmatter, so there
is no such thing as an invocation-scoped write grant.) Triage stays read-only
forever.

**Known gap — `destinationProject` is ambiguous in a monorepo.** The field is a
project *name*, never a UUID, but §4.0 gives every product its own standing
`Maintenance` project, and the ensure pass (§3.11) creates them. A repo binding
two initiatives therefore ends up with two projects named `Maintenance` in the
same team, and `TriageItem` carries no initiative field, so the name alone
cannot say which product the operator meant. The apply pass resolves the name
and, when it matches more than one project, applies **no** project and records
the ambiguity in the applied marker — attaching an issue to the wrong product's
project is worse than leaving it unset for a human. Closing this properly means
giving `TriageItem` an initiative, not teaching the resolver to guess.

**Permission:** may recommend `Canceled` freely. Un-actioned `Low` items older
than 90 days should be proposed for cancellation by default.

**Weakest link:** dedupe against a large backlog. The schema's
`severityReasoning` and dedupe fields are the tuning log — read them for the
first week before touching the threshold.

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
3. Draft the description in the §13.1 template — or, for intake-drafted
   issues (§3.12), verify and revise the draft against the code. Returned as
   `refinedDescription`, never written directly.
4. Acceptance criteria as observable behaviors, verifiable by someone who didn't
   write the code. Do not restate the Definition of Done.
5. Identify affected files/modules via LSP, not guesswork.
6. Estimate. If ≥5, specify the split in `subIssues[]` with per-sub-issue
   estimates; the parent becomes a tracking issue and does not get
   `agent:ready`.
7. If a genuine unknown blocks estimation, specify a `type:spike` (§13.3) in
   `spikeCreated` with a native `blocks` relation to the original. Do not guess.
8. Yield the `RefineResult`. The extension applies it: description, sub-issues,
   spike, `agent:ready`, move to Todo, strip `legacy`.

Step 1 is the enforcement mechanism for "never bulk-refine the backlog."

### 7.3 `foreman-implement`

```yaml
tools: [read, edit, write, search, lsp, dap, exec,
        foreman_linear_read, foreman_github_pr]
spawns: false
blocking: false
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

1. Verify the lock. The dispatcher claimed `agent:running` with this dispatch's
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
blocking: false
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
of the cycle machine-checkable: the review worker re-dispatches whenever the
PR's head SHA has no `ReviewResult` (§17.5), and blocking findings route back
automatically — the extension writes the findings to the issue and re-dispatches
implement, which lands in resume mode (§7.3 step 2), pushes fixes, and yields an
updated result; the new head SHA triggers re-review. When the implement agent's
process is still alive (interactive or herdr-dispatched sessions), messaging the
parked agent via `hub` is a cheaper equivalent — but under the loop's
`PrintDispatcher` every dispatch is a fresh process and the registry dies with
it (§11), so resume-mode re-spawn is the primary path, not a fallback. After
**2** review→fix cycles without a clean result, convert to
`blocked:needs-decision` (§17.8) — a standing disagreement between implement and
review is operator information, not something to ping-pong overnight.

**No merge authority.** Do not build auto-merge in the first pass.

### 7.5 Explicitly not an agent

**Prioritization and roadmap.** Requires context that cannot be reconstructed
from the repo or Linear. Operator, weekly, ~1 hour.

**Applying approved proposals.** Deterministic; extension code (§7.1).


### 7.6 `foreman-plan`

```yaml
tools: [read, search, lsp, foreman_linear_read]
spawns: false
blocking: false
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
| **Trigger** | The loop's `plan` worker (§17.5), at any in-scope, non-Maintenance project with zero issues in any state. Never called mid-flow by another agent. |
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
`type:`, a §13.1-shape description, draft acceptance criteria, a rough
priority, and a rough estimate. Record explicit non-goals in `outOfScope`.

**Output:** a `PlanResult`. The extension creates each `proposedIssues[]`
entry as a new Backlog issue under the project — nothing else. None of them
carry `agent:ready`; every one enters the normal refine funnel the moment
the operator sets a priority, exactly the path any other Backlog issue
takes. `foreman-refine` verifies and revises each draft against the code
before it reaches Todo, the same way it already handles intake-drafted
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
or `/foreman-status`, not a queued dispatch. Closing this properly means
giving Linear (or Foreman's own state) a real per-project marker; until
then, `foreman-plan` should default to proposing the smallest *complete*
slice it can rather than banking on a pass that isn't coming.

**No Linear-visible block surface.** A `BlockRecord` from `foreman-plan` has
no existing issue to attach a `blocked:*` label to — the project has none
yet by construction. The extension logs the block rather than writing it to
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
code, the same authority class as `/foreman:apply` (§7.1) and the reaper
(§11) — a plain function over already-fetched state, not a model call.

| Transition | Trigger | Who |
|---|---|---|
| *(create)* → `planned` | `foreman-plan` creates a project's first slate of issues (§7.6) | `applyPlan`, same mutation batch |
| `backlog`/`planned` → `started` | Any issue reaches an active or completed workflow-state type | loop's `project-status` worker (§17.5) |
| any → `completed` | Every issue is terminal (completed or canceled) and at least one completed | loop's `project-status` worker |

**Deliberately restrained.** Only the two directions with no reasonable
disagreement are automated. `paused` and `canceled` are exclusively the
operator's call and are never read as *inputs* to a decision, nor ever
written by the loop — a project the operator paused or canceled stays
exactly where they left it regardless of what its issues do afterward. An
all-`canceled` issue set does not auto-complete a project either: that is
abandonment, a judgment call, not a shipped increment.

**Bare-project exclusion.** A project with zero issues never transitions —
that is `foreman-plan`'s own trigger condition (§7.6), not this worker's; the
two never compete for the same project at the same time. The standing
`Maintenance` project (§3.11) is excluded entirely, the same guard `plan`
uses — it never closes, so it is never a `completed` candidate.

---

## 8. Skills

| Skill | Bound to | Produces | Authority |
|---|---|---|---|
| `foreman-triage-inbox` | triage | `TriageProposal` | Propose only |
| `foreman-plan-project` | plan | `PlanResult` | Creates issues under one bare project |
| `foreman-refine-issue` | refine | `RefineResult` | Applies to one prioritized issue |
| `foreman-spike` | refine, operator | Findings + follow-up issues | Investigation only; no production code |
| `foreman-implement-issue` | implement | `ImplementResult` | Full within acceptance criteria |
| `foreman-review-diff` | review | `ReviewResult` | Advisory only |
| `foreman-block-protocol` | all five | `BlockRecord` | — |

Each skill defines: preconditions (the gate it enforces), required reads,
ordered procedure, the output schema it fills, **stop conditions** (the
enumerated cases requiring §9), and explicit non-goals.

`foreman-implement-issue` must include the **resume procedure** as a first-class
path, not an afterthought: detect existing worktree → read prior
`BlockRecord`/findings and the operator's reply → continue from partial commits.
This is the path both `/foreman:unblock` fresh-spawn fallback (§9) and the
review fix cycle (§7.4) depend on.

`foreman-block-protocol` bound to all five via `autoload-skills` is what makes
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
the blocker). Apply **no** `blocked:*` label; the relation is the state and
resolves itself. Yield a `BlockRecord` with `type: dependency`; the extension
releases the lock and moves the issue back to Todo. The incomplete relation now
fails the implementation gate, so the implement worker skips it; when the
blocker completes, the relation resolves, the gate passes, and the next loop
pass re-dispatches — landing in resume mode (§7.3 step 2). No manual step.

**Case B — blocked on a human.** Yield a `BlockRecord` with the question or
enumerated options, the recommendation, the state left behind (worktree path,
partial commits), and the cost of a wrong guess. The extension writes the Linear
comment, applies the `blocked:*` label, releases the lock, moves the issue back
to Todo, and leaves the worktree intact with the branch pushed. The label keeps
every worker away (§17.5) until the operator answers.

Budget exhaustion (§3.6) converts into Case B rather than a silent stall. This is
well-supported: a soft-budget abort on a non-isolated kept-alive agent leaves the
agent `idle` and resumable.

**Resuming.** `/foreman:unblock <ISSUE-ID>` records the operator's reply as a
comment and clears the `blocked:*` label.
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
Never reimplemented in prose. `legacy` never bypasses a gate — legacy issues
route through the refine worker instead (§4.9, §17.5).

**Refinement gate** (`Backlog → Todo`): belongs to a project with exactly one
initiative (§4.0); `type:` present; Priority ≠ `None`; description has
`## Acceptance Criteria`; ≥1 criterion; estimate set and ≤3; no `blocked:*`
label.

**Implementation gate** (`Todo → In Progress`): refinement gate satisfied;
`agent:ready` present; `agent:running` absent; `agent:hands-off` absent; no
incomplete `blocked by` relations.

**Review gate** (`In Review → Done`): a `ReviewResult` exists for the
**current head SHA**; CI green; zero `blocking` findings outstanding; every
acceptance criterion checked off; Definition of Done satisfied. In PR mode
(§3.10) the PR must also be open; with `pr.required: false` the pushed branch
is the review target.

---

## 11. Locks and crash recovery

`agent:running` is a lock and every lock needs a reaper. omp's own registry
(`running | idle | parked | aborted`) is **process-global and dies with the
process**, while the Linear label outlives it — so the reaper is still required,
but it can cross-reference the registry to decide whether a lock is genuinely
orphaned or just held by a live agent.

**`foreman-plan` carries no lock.** `agent:running` is an issue label, and a
bare project has no issue yet — the loop's own bookkeeping (a project id
recorded against the `plan` dispatch, §17.5) is what stops a second dispatch
from racing the first before its issues land, not this mechanism.

- **The dispatcher claims; agents never do.** The extension applies
  `agent:running` *before* the spawn (§17.5) and releases it when the yield is
  consumed. The label is the mutex; the dispatch ID and timestamp ride in a
  machine-readable lock comment (`foreman:lock`) written in the same mutation —
  a label can't carry them, and the reaper and the agent's verify step both
  need them. Release marks the comment released. Agents verify via
  `foreman_linear_read` that the live lock comment carries their dispatch ID
  (§7.3) and otherwise never write or clear anything. One owner, no claim race,
  and manual and loop dispatch share the code path.
- TTL derives from the runtime cap: 2× `task.maxRuntimeMs` plus margin — with
  the 2 h cap (§3.6), ~4–5 h. Long implementations are legitimate; a lock
  outliving twice the hard runtime cap is not.
- Sweep on `session_start` and on a timer: clear expired locks whose dispatch ID
  is absent from both the registry and the loop's bookkeeping (§17.5), post what
  was found and when it was taken, flag the worktree.
- **The reaper never deletes a worktree.** It reports; the operator decides. An
  automated delete that races a still-live agent loses work.
- Subscribe to `task:subagent:lifecycle` to clear locks promptly on clean abort
  rather than waiting out the TTL.

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
  a merge is confirmed — `merge-detect` (§17.5) and the operator-invoked
  `/foreman:merge` both call it right after moving the issue to Done. Gated
  by `loop.cleanupMergedWorktrees` (default `true`), and skipped — with a
  logged note, never an error — when the worktree still has uncommitted
  changes. Never runs for a crashed or orphaned lock; that stays the
  reaper's report-only territory (§11).

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
| `foreman repo` (per repo) | Every 5–10 min | Scheduler | — |
| `foreman team` (team-level) | Daily window | Scheduler | — |
| Triage approval | Daily | Operator | ~10 min |
| Blocked drain (`/foreman:status`) | 1–2× daily | Operator | ~15 min each |
| Prioritization / roadmap | Weekly | Operator | ~1 hour |
| Workflow retro | Every 2 weeks | Operator | ~30 min |

Refinement no longer has a cadence row — the loop dispatches it as soon as an
issue has a priority. That makes weekly prioritization the throttle on
everything downstream: nothing gets refined, implemented, or reviewed until the
operator sets a priority, which is exactly where the human judgment belongs.

Planning has no cadence row either, for the same reason: `foreman-plan` runs
inside `foreman repo` (§17.5), dispatched the moment a project is bare — not
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

**Verified against omp documentation:** plugin layout and marketplace catalog
format; user vs. project install scopes; the `omp.extensions` manifest key and
its silent-failure mode; agent discovery precedence, case sensitivity, and
`.omp`-roots-only scanning; skill provider priorities; `tools` allowlist
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

### 17.1 The loop is a state machine, not an agent

The obvious move is a long-running "orchestrator" agent that watches the board
and decides what to run next. Don't build it. Every routing decision Foreman
makes is already a pure predicate over Linear state — the gate validators in
§10 *are* the routing table. Putting an LLM in that path pays model cost and
adds nondeterminism to something fully determined, and when it misroutes you
get to debug a prompt instead of reading a function.

The supervisor is a plain Node process — `foreman repo [--team <KEY>]`, run
in the repo it serves (§3.11) — that imports the same validators as the
extension. One instance per repo, each scoped to that repo's bound
initiatives. It contains no model call. When it decides to dispatch, it hands the decision to a Dispatcher
(§17.2), which launches the same command the operator would type (§3.4). LLM
work happens only inside agents.

### 17.2 Dispatchers

The scheduler decides *what* to run. How a spawn actually gets launched is a
separate, swappable concern behind a small interface:

```ts
interface Dispatcher {
  dispatch(agent, issueId, command): Promise<Handle>
  status(handle): "starting" | "running" | "settled" | "lost"
  attach?(handle): void        // herdr only
}
```

Two implementations:

- **`PrintDispatcher`** — `omp -p '/foreman:implement ENG-142'`. No
  dependencies, works headless anywhere, zero visibility while running. **Pass
  the approval-mode flag explicitly** — the print-mode parent session is the
  same second interrupt surface described in §17.3, and left at defaults it can
  stall headless on its own tool calls.
- **`HerdrDispatcher`** — a real terminal pane per agent, live state, and the
  ability to attach and take over. Requires the herdr server.

**Keep herdr optional.** It is the better daily driver (§17.3) but it is a
stateful dependency in the dispatch path, and Foreman should degrade to print
mode when the server isn't there rather than stalling the loop. Build
`PrintDispatcher` first and get routing correct against it; adding the terminal
layer at the same time means you cannot tell whether a bug is in `nextAction` or
in pane management.

### 17.3 The herdr dispatcher

Herdr is a terminal workspace manager with a background server: panes survive
client detach, laptop close, and network loss, and reattach locally or over SSH.
`omp` is a first-class agent kind, so `agent start … --kind omp` is native
rather than a shell hack. Given how much the loop runs unattended, and how often
you're reaching a machine over Tailscale rather than sitting at it, this fits
better than fire-and-forget print mode.

**The rule that makes it safe: herdr agent state is never a routing input.**

Herdr classifies agents as `working`, `idle`, `done`, `blocked`, or `unknown` by
recognizing patterns in terminal output. Its own docs are explicit that
`unknown` "does not prove successful completion." That is fine for directing
human attention and unacceptable as a source of truth for whether an issue
advanced. Linear state plus the validated structured output (§6) remain
authoritative for every `nextAction` decision. Herdr state drives the sidebar
and `/foreman:status` ordering — nothing else.

**Terminology collision, and a useful diagnostic.** Herdr's `blocked` means it
recognized an approval or question UI on screen. Foreman's `blocked` means a
`BlockRecord` was written to Linear. They are unrelated, and conflating them
will cost you an afternoon. Better: treat any herdr `blocked` as a **Foreman
bug**. The design says agents never ask questions and never hit approval
prompts, so a recognized approval UI means either the parent session's approval
mode wasn't configured or an agent found a path around the block protocol.
Surface it in `/foreman:status` as an anomaly, not as a normal queue.

Set the dispatched session's approval mode explicitly. Subagents get forced
`yolo`, but the *parent* session herdr launches is interactive and can prompt on
its own tool calls — a second interrupt surface that bypasses `BlockRecord`
entirely if left at defaults.

**Layout.**

| Herdr object | Foreman mapping |
|---|---|
| Workspace | One per repo — the instance and its bound initiatives (§3.11). |
| Tab | One per in-flight issue, named for the issue (`ENG-142`). |
| Pane | The agent, `--cwd` set to that issue's worktree. |
| `foreman` workspace | The `foreman-board` and `foreman team` panes plus a scratch tab for short-lived triage/refine/review agents, which need no worktree. Each repo workspace holds its own `foreman repo` pane (§3.11). |

Tabs are bounded by the WIP limit (§17.6), so at WIP 3 the layout stays legible
rather than becoming a wall of panes.

**Naming.** Agent names must match `[a-z][a-z0-9_-]{0,31}`, must be unique among
live agents, and the alias is cleared when the agent exits. Use
`foreman-<issue-id>` lowercased — naturally unique per in-flight issue, and it
matches the lock model exactly. Capture pane IDs from the JSON that creation
commands return; never predict them, and re-read `.result.move_result.pane.pane_id`
after any `pane move`, since moving a pane between workspaces changes its
qualified ID.

**Sidebar tokens.** Herdr accepts pane and workspace metadata tokens that render
in sidebar rows. Push the issue ID and current gate state as tokens with a TTL,
so the sidebar shows Linear truth rather than only scraped terminal state. Use
`--source foreman` and `--seq` so stale reports are ignored.

**Do not collect results by reading panes.** `agent read` returns
`agent_not_idle` while an agent is working, and alternate-screen history reads
are fragile. Foreman already has a better channel: the agent writes structured
output, the extension writes Linear, the loop reads Linear. Pane reads are for
the human looking at a stuck agent.

**Always pass `--timeout`.** Herdr wait commands have no default and will block
indefinitely. Pair every wait with `task.maxRuntimeMs` on the omp side so
neither layer can hang forever.

**Worktrees stay Foreman's.** Herdr can create them; don't let it. Foreman owns
worktree lifecycle (§3.7, §12), and a terminal manager deciding branch and
checkout contracts is exactly the coupling to avoid.

### 17.5 Stage workers

One supervisor process, several independent workers — not one monolithic sweep.
Stages have wildly different durations (refine is minutes, implement can be
hours), so a single cadence and a single WIP number is wrong for both, and a
single sweep means implement starves waiting for refinement to happen in the
same pass.

```
foreman repo  (one process per repo, one lockfile each, N async workers)
  ├─ reaper           every 5 min   — stale locks (§11)
  ├─ project-status   every 5 min   — sync Linear's native project status (§7.6a)
  ├─ plan             every 5 min   — decompose any bare (zero-issue) project
  ├─ refine           every 5 min   — top Ready buffer up to target
  ├─ implement        every 5 min   — pull from Ready
  └─ review           every 5 min   — PRs whose head SHA has no ReviewResult
```

Triage is not a loop worker — it belongs to the team-level `foreman team`
process (§3.12).

Each worker owns one transition and evaluates only its own predicate:

| Worker | Selects | Condition | Dispatches |
|---|---|---|---|
| `plan` | In-scope, non-Maintenance projects | zero issues in any state, no `plan` dispatch already in flight | `foreman-plan` |
| `refine` | Backlog; plus `legacy` in Backlog or Todo (§4.9) | priority ≠ None, no `agent:*` | `foreman-refine` |
| `implement` | Todo | implementation gate passes | `foreman-implement` |
| `review` | In Review | PR open, no `ReviewResult` for head SHA | `foreman-review` |

`plan` is the one worker whose candidates are projects, not issues — its
in-flight tracking is loop bookkeeping keyed by project id (below), not the
`agent:running` label the other three share. `project-status` reads and
writes projects too, but dispatches no agent — it is a housekeeping pass like
the reaper, not a `nextActions` stage (§7.6a).

Nothing is dispatched for an issue carrying `blocked:*`, `agent:proposed`,
`agent:running`, or `agent:hands-off` — every worker checks these first.

**One process, not six.** Independent cadences, but a shared lockfile, shared
global counters, and one place to read logs. Six separate processes
multiplies the singleton problem by six and gives you no shared view of
total load.

**Claim before dispatch, not after.** Workers overlap and a slow spawn would
otherwise double-fire. The extension writes `agent:running` with a dispatch ID
first (§11), closing the window; the reaper cleans up spawns that die between
claim and start. The Linear label is the mutex across all workers — that is
what makes concurrent stages safe. Agents verify the ID; they never claim.

**Loop bookkeeping.** Attempt counters (§17.8), review-cycle counters (§7.4),
last-triage-run (so a mid-day loop restart doesn't refire the daily batch),
`reviewedSha` per PR, and dispatch history live in a small SQLite (or JSON)
file in `~/.foreman/state/<repo-alias>/` (§3.11). Explicitly
**non-authoritative** — it is dispatch
bookkeeping, not workflow state, so it does not create a second source of truth
beside Linear. Lost or corrupted, the worst case is one redundant dispatch or
one premature retry; the reaper reconciles it against Linear and the registry
on start.

Poll on a 5-minute cadence. Linear webhooks would be more responsive and are a
reasonable later optimization; nothing here needs sub-minute latency.

### 17.6 WIP limits

Two layers, and the global one is the one that protects you.

**Global cap on concurrent agents. Start at 3.** Per instance (§3.11) — each
repo's loop caps its own agents; the cross-instance guard is team-wide
backpressure (§17.7). This governs. The failure mode of an autonomous loop is
generating work faster than the operator can absorb it, and a low ceiling is
the only thing that surfaces that early enough to correct. Running several
instances multiplies effective volume, so start additional instances with the
same caution as raising the cap.

**Per-stage sub-limits**, which must sum to more than the global cap or they do
nothing useful — they shape the mix, the global cap sets the volume:

| Worker | Sub-limit | Note |
|---|---|---|
| `plan` | 1 | Coarse and rare — one project decomposition at a time by default. |
| `refine` | 2 | Short, cheap, keeps the buffer stocked. |
| `implement` | 3 | The expensive one. |
| `review` | 2 | Fast, and unblocks merges. |

If the global cap is 3 and implement is holding all three, refine waits. That is
correct — starting refinement you can't act on is just queue growth.

**Refine targets a buffer depth, not a WIP count.** The refine worker's job is
to keep the Ready view stocked at N issues (start at 5), not to process
everything prioritized. Below target, it refines; at target, it idles. This is
what lets implement run continuously without ever waiting on refinement latency,
while still honoring the rule that refining far ahead of what you'll build is
waste (§7.2).

These are all separate from `task.maxConcurrency`, which bounds fan-out inside a
single omp session. Foreman's agents span sessions and processes, so it needs its
own counters, held in Linear where every worker can see them.

### 17.7 Backpressure — the rule that makes this safe

**If the Blocked (human) queue exceeds a threshold, every worker stops
dispatching new work.** Threshold starts at 5, and the count is **team-wide**,
not per-instance (§3.11): every instance queries `blocked:*` across the whole
team, so N repos' loops all throttle against the one operator's actual drain
rate, with Linear as the only coordination point.

Backpressure is global, never per-stage or per-instance. This matters more now that stages run
independently: a per-stage rule would let refine keep stocking the Ready buffer
while you're drowning in blocked implement work, so you'd surface from the drain
to find a large queue of refined issues nobody can start on. One tripwire, all
workers.

Without this, the loop runs unattended overnight and produces forty blocked
issues, each holding a worktree, each needing a decision. That is strictly worse
than having done nothing: the operator now faces a queue larger than a day's
attention, and the work is stale by the time it's unblocked. A loop with a human
decision point in it must be rate-limited by that human's actual throughput, not
by machine capacity.

The same rule applies to unapproved proposals: if the team-wide
`agent:proposed` count exceeds the threshold, the intake process (§3.12)
skips its dispatch — there is no point generating proposals faster than
they're being approved.

Backpressure state belongs in `/foreman:status` so it's visible why the loop
went quiet.

### 17.8 Retry and failure

An agent returning a non-zero exit or a failed schema validation increments an
attempt counter in the loop's bookkeeping (§17.5). After two failures, stop
retrying and convert to a `blocked:needs-decision` with the failure output
attached. A loop that retries indefinitely burns budget on something
structurally broken, usually an under-refined issue.

One carve-out: a schema-invalid yield from a budget force-stop (§3.6) is not a
failure — the agent was cut off mid-thought, not broken. The extension detects
the abort via the lifecycle events (§3.5), synthesizes a Case B `BlockRecord`
from the partial output, and routes it through §9 instead of the retry counter.

Review→fix cycles are counted the same way and capped at **2** (§7.4); hitting
the cap converts to `blocked:needs-decision` with both the findings and the
implement agent's last result attached.

### 17.9 Autonomy

There are exactly two loop modes, `loop.mode`: `confirm` (the default) and
`yolo`.

`confirm` asks the operator, on the loop's own terminal, before every action
that changes state *outside the loop process*: every agent dispatch and every
Linear mutation. Reads are never gated — the loop still evaluates every
worker's predicate and still logs its intent either way. The loop's own
`status.json` / `bookkeeping.json` / `loop.lock` writes are not gated either;
those files are how the process remembers what it already did, so prompting
for them would make `confirm` mode unable to keep books rather than more
careful.

Declining is how you get a dry run: the loop still evaluates, still logs its
intent, and records a skip (`dispatch-declined`, `linear-write-declined`).
There is no separate dry-run rung, because answering `n` to everything is the
same thing, and it lets you say yes to the one dispatch you did want.

`loop.workerModes` overrides `loop.mode` per worker. `{ "review": "yolo" }`
reproduces exactly what the old read-only-auto rung used to do — every
worker but review evaluates and asks, review dispatches unattended — which is
why that rung is gone rather than renamed: it is one entry in a map, not a
separate stage of the ladder.

`confirm` mode needs a terminal. A loop started with any worker's effective
mode resolving to `confirm` and no TTY attached refuses to start rather than
declining everything silently — there would be nobody to ask.

Merge authority never enters the loop. The operator merges, in either mode.

Tune WIP and backpressure upward only after a stretch where the blocked queue
consistently drains to zero within a day. If it doesn't drain, the constraint is
the operator's attention, and raising the limits makes throughput worse rather
than better.

`loop.mode: "yolo"` and `agent.approvalMode: "yolo"` are different settings
at different layers and neither implies the other. `loop.mode` governs
whether the supervisor asks *its* operator before dispatching or writing to
Linear. `agent.approvalMode` is the omp approval mode each dispatched agent
session itself runs under, once dispatched. A `confirm`-mode loop can still
dispatch agents that run with `approvalMode: "yolo"` inside their own
sessions, and a `yolo`-mode loop can dispatch agents pinned to a stricter
`approvalMode`.

---

## 18. Build order

1. **Plugin skeleton + Linear config.** Correct `omp.extensions` key, local
   marketplace install, `/reload-plugins` loop working. The `core` config
   loader with schema validation, layering, and defaults (§3.10). Workspace
   topology per §4.0: single team, default issue template → Triage,
   initiatives enabled, one initiative per product (grouping prefixes where
   wanted), the `repos` registry populated and the ensure pass
   creating `Maintenance` projects (§3.10, §3.11). Then Linear
   states, load-bearing labels, `legacy` amnesty pass (including homing
   projectless issues, §4.9), six saved views, one worked product `Context`
   doc + project brief with a Definition of Done. Resolve §16 items 5, 7,
   and 9. ~1 day.
2. **Schemas + extension core + interrupt protocol.** The four result schemas
   and `BlockRecord` union first — everything downstream consumes them. Then
   typed Linear read tools, the result-application layer that makes the
   extension the sole Linear writer (principle 9), gate validators, the lock manager
   (dispatch IDs, claim/release), the lock reaper, the config loader's
   `session_start` validation, scope check, and ensure pass (§3.10, §3.11),
   lifecycle listeners,
   `foreman-block-protocol` skill, the skill-name resolution guard (§8), and
   `/foreman:status`. Verify §16 items 1 and 2 here. ~2 days. Build before any
   agent — retrofitted, one agent gets a "just ask the user" fallback and it
   becomes the default.
3. **`foreman team` + `foreman-triage`, propose-only.** The team-level
   process (§3.12): registry-derived repo lookup, daily window, the drafting
   agent, and the apply pass — creating nothing without approval. ~1 day. **Run it for a
   week before building anything else.** Its bad proposals — especially the
   project briefs — teach more about where the operator's judgment lives than
   designing the rest up front.
4. **`foreman-refine` + `foreman-spike`.** After triage tuning. ~half a day.
5. **`foreman-implement` + `foreman-review` + the fix cycle + TTSR rules.**
   Shaped by what 3 and 4 revealed. Includes the resume-mode path in the
   implement skill, the findings route with its cycle cap (§7.4), both merge
   modes and `/foreman:merge` (§3.10). ~1.5 days, most of it in worktree
   lifecycle and the fix cycle.
6. **`foreman repo` + `PrintDispatcher` + autonomy (§17.9).** The CLI
   with team resolution (§3.11), supervisor, per-repo lockfile, bookkeeping
   file, the three stage workers plus reaper, per-instance cap and per-stage
   sub-limits, Ready buffer target, team-wide backpressure, retry counter,
   `Confirmer`/`--mode`. Prove it single-instance in one repo before starting a
   second.
   ~1.5 days. Start with the `implement` worker alone and add the others one at
   a time — four workers introduced together makes a routing bug impossible to
   attribute. Then run a week in `confirm` mode before switching to `yolo`.
7. **`HerdrDispatcher` (optional).** Workspace/tab/pane layout, agent naming,
   sidebar tokens, attach path, print-mode fallback. ~half a day. Only after
   step 6 is boring.

Roughly 9 focused days of build, spread across several weeks of observation
windows. The waiting is the point; compressing it is how you end up with a loop
that dispatches confidently into a routing bug.

---

## 19. Non-goals

- Auto-merge on clean review, in either loop mode
- An orchestrator *agent* — routing is a pure function (§17.1)
- Agents holding Linear or GitHub write tools (implement's `foreman_github_pr`
  excepted) — the extension is the sole writer (principle 9)
- An uncapped review→fix cycle (§7.4)
- A loop that dispatches without a WIP limit or backpressure
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
- Unapproved project creation — intake *proposes* milestone projects with the
  brief already written (§3.12), but nothing is created until the operator
  approves; the ensure pass auto-creates only the standing `Maintenance`
  project (§3.11)
- A second intake process — the team inbox has exactly one consumer (§3.12)
- A central daemon watching all of Linear — the instance model (§3.11) is
  per-repo by design
- An `area:` ontology beyond what `foreman-implement` reads
- Publishing to a public marketplace before it works locally
- Config keys that can disable gates, WIP limits, backpressure, the lock
  protocol, or propose-before-apply — config tunes parameters, never removes
  invariants (§3.10)

---

## 20. The control plane

### 20.1 Two loop kinds, one control surface

Every long-lived Foreman process — a per-repo loop (§3.11) or the team-level
intake process (§3.12) — is a *loop* for the purposes of this section, and
each exposes the same control surface under an id: `repo:<alias>` for a
per-repo loop, `intake` for the singleton intake process. The id is also the
state directory name: `~/.foreman/state/<id>/` (the bookkeeping file of
§17.5 lives one level inside it). Two files live there for control purposes:

| Path | What |
|---|---|
| `<stateDir>/<id>/control.sock` | A unix socket, live while the loop holds its lock (§11) |
| `<stateDir>/<id>/status.json` | A `LoopSnapshot`, written atomically after every `reconcile()` and after every tick |

The socket is the control channel. The file is the fallback: a client that
cannot reach the socket — the loop process is down, or a client asks before
the loop has ever registered a control server — still gets a truthful "last
known state" by reading `status.json` instead of an error. This is what lets
a status-reading client render a stopped loop's board without special-casing
it, and it is why the write happens at exactly the two moments state can have
changed: `reconcile()` and each tick, never on a timer of its own.

`foreman repo --no-control` disables the socket for a given process and skips
straight to writing `status.json` — an escape hatch for running a loop where a
listening socket is unwanted, not the normal path.

### 20.2 Wire protocol

Newline-delimited JSON over the unix socket, one connection per client,
request/response with an out-of-band event channel for `subscribe`:

- **Request** — `{ op, id, ...params }`. `id` is chosen by the client and
  echoed back so a client with several in-flight requests can match replies.
- **Response** — `{ id, ok: true, result }` or `{ id, ok: false, error }`.
- **Event** — `{ seq, at, ...}`, pushed unprompted to a subscribed connection
  after a successful `subscribe`. `seq` is per-connection and monotonic;
  a client that sees a gap knows it missed events and should re-`snapshot`.

Ops: `hello` (handshake — protocol version, loop id), `snapshot` (the current
`LoopSnapshot`, the same shape `status.json` holds), `subscribe` (start
receiving events), `pause` / `resume` (stop or resume dispatch without
releasing the lock), `stop` (graceful shutdown), `tick` (run one scheduling
pass immediately, outside the cadence), `setMode` (change `loop.mode`),
`patchConfig` (merge a partial config document and hot-reload it), `reload`
(re-read config from disk without a patch), `attachAgent` / `killAgent`
(herdr-pane operations, §17.3 — a no-op reply naming the print-mode fallback
when there is no herdr pane to attach to), and `logs` (tail the loop's own
log, not an agent's).

A `LoopSnapshot`, by field group rather than a full type dump: identity (loop
id, mode, paused/running), the per-worker table from §17.5 (last run,
in-flight count, next scheduled run), the WIP and backpressure numbers of
§17.6–§17.7 as measured right now, the blocked and proposed queues (issue ids
and labels, not full issue bodies — the client fetches those from Linear
directly if it needs them), and recent log lines for the overview view. It is
deliberately the read side only: nothing in the shape is round-tripped back
through a write op except `setMode` and `patchConfig`, and those go through
their own named ops rather than a general "set snapshot field" verb.

### 20.3 The control plane adds no new authority

Every op in §20.2 is either a read (`hello`, `snapshot`, `subscribe`, `logs`)
or a call to a state transition the loop already makes on its own schedule
(`pause`/`resume` stop and start the same dispatch loop the cadence drives;
`tick` runs the same scheduling pass early; `stop` is the same shutdown path
as `SIGTERM`). `setMode` and `patchConfig` write to
`~/.foreman/config.json` (§3.10) exactly as hand-editing the file and letting
the config loader's `session_start` validation pick it up would — they tune
parameters, never invariants. There is no op that creates, transitions, or
comments on a Linear issue, approves a proposal, or claims a lock (§11) on the
control plane's behalf: those actions have exactly one path each, the ones
§10 and §9 already define, and the control plane is not a second one. A
client with a live socket connection has exactly the leverage an operator
editing the config file and sending `SIGHUP` would have — nothing more.
