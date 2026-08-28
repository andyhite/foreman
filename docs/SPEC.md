# Foreman — Build Specification

An omp-native plugin that runs a single-operator agile SDLC over Linear.

**Harness:** omp (oh-my-pi), installed as a user-scoped plugin.
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
    omp-plugin/                 # below — installed user-scoped in ~/.omp/plugins/
    loop/                       # supervisor + stage workers (§17.5)
    herdr-plugin/               # optional: herdr-plugin.toml + board TUI (§17.4)
```

The omp plugin is a Claude/OMP-compatible plugin directory, installed
**user-scoped** so it applies across all personal repos. During development, add
its containing directory as a local marketplace source; `/reload-plugins` picks
up changes without a restart.

```
packages/omp-plugin/
  .claude-plugin/plugin.json
  package.json                  # omp.extensions declaration
  agents/
    foreman-triage.md
    foreman-refine.md
    foreman-implement.md
    foreman-review.md
  skills/
    triage-inbox/SKILL.md
    refine-issue/SKILL.md
    spike/SKILL.md
    implement-issue/SKILL.md
    review-diff/SKILL.md
    block-protocol/SKILL.md
  commands/
    foreman-triage.md  foreman-refine.md  foreman-implement.md
    foreman-review.md  foreman-status.md  foreman-unblock.md
  rules/
    no-interactive-questions.md
    no-scope-expansion.md
    no-gate-bypass.md
  schemas/                      # JSON Schema for each agent's output (§6)
  src/
    extension.ts
    dispatch/                   # Dispatcher interface + print/herdr impls (§17.2)
  dist/
```

The board TUI is TypeScript for the same reason — it imports `core` and renders
the same validated objects the agents produce. A Rust TUI would render faster
and duplicate the entire Linear layer; not worth it at this scale.

**Manifest footgun:** the omp key for extension modules is `omp.extensions` (an
array), not `omp.hooks`. Resolution is `pkg.omp` first with fallback to
`pkg.pi`; declaring the wrong key means the extension silently never loads and
nothing warns you. There is a public bug trail on exactly this.

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
| `/foreman-triage` | `foreman-triage` over the Inbox view | none |
| `/foreman-refine` | `foreman-refine` | `<ISSUE-ID>` |
| `/foreman-implement` | `foreman-implement` | `<ISSUE-ID>` |
| `/foreman-review` | `foreman-review` | `<ISSUE-ID>` or PR |
| `/foreman-apply` | no agent — the extension applies approved proposals directly (§7.1) | none |
| `/foreman-merge` | no agent — the extension merges via the configured strategy once the review gate passes (§3.10) | `<ISSUE-ID>` |
| `/foreman-unblock` | no agent — records the operator's reply and clears the block; the loop dispatches the resume (§9) | `<ISSUE-ID>` |
| `/foreman-status` | no agent — renders the operator console | none |

Each dispatch command body must: resolve the target issue, assemble the shared
`context` (the two-layer Context digest per §4.7 + the issue), state the agent to spawn,
and state the gate that must hold. It must **not** restate the procedure — that
lives in the autoloaded skill (§8). A command that duplicates its skill will
drift from it.

**These commands are also the loop's dispatch surface** (§17). The scheduler
shells the same command the operator types, via print mode. One code path,
so manual and automatic runs cannot diverge.

`/foreman-status` is the in-chat operator console: blocked queue, in-flight
locks, proposals awaiting approval, live agent registry, and loop state. Build
it early — it is how the interrupt-batching model gets used before the board TUI
(§17.4) exists, and it remains the fallback when herdr isn't running.

### 3.5 Extension module

`src/extension.ts` registers via the `pi.on(...)` event bus and owns everything
that must be real code:

1. **Typed Linear tools.** Ship first-class read tools (TypeBox schemas) rather
   than routing through generic MCP — `foreman_linear_read` is what agents get.
   The write client exists only *inside* the extension and is never exposed as
   an agent tool (principle 9). This is stronger than a read/write tool split:
   there is no allowlist mistake that can hand an agent write access, because
   no write tool exists to grant.
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
6. **Config loader.** Reads and validates the layered `.foreman/config.json`
   files (§3.10) — including the repo map keyed by **initiative ID** (IDs, not
   names — grouping prefixes rename): `repos: { <initiative-id>:
   <repo-path> }`, one entry per product, set once. Resolution: issue →
   project → its single product initiative (§4.0) → map entry → fail loudly.
   Consumed by worktree creation, triage repro reads, and the loop. Validated
   on `session_start` alongside the skill-name guard (§8); a dispatch whose
   repo cannot resolve, or an invalid config, fails loudly before any spawn.
   A project-level override is deliberately absent — nothing needs one today,
   and the resolution chain makes adding it a five-line change when something
   does.
7. **Subagent lifecycle listeners.** `task:subagent:lifecycle`,
   `task:subagent:progress`, and `task:subagent:event` fire on the parent bus.
   Use them to keep `/foreman-status` live and to detect aborts.
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
invoking print mode (`omp -p`) against `/foreman-triage` — superseded by the
loop's triage worker once §17.5 exists. Do not run both.

### 3.9 Hindsight memory — decide explicitly

omp extracts durable facts per project into `~/.omp/agent/memories/` and injects
a summary at session start. Foreman makes Linear the single source of truth for
project state. A stale memorized "decision" can contradict the current `Context`
doc with no way for the agent to know which is authoritative. Recommend
disabling autonomous memory for Foreman-managed repos so one source of truth is
actually one.

### 3.10 Configuration — `.foreman/config.json`

Everything that is a *parameter* rather than an *invariant* lives in layered
JSON config, loaded and schema-validated by `core` (TypeBox — the same
machinery as the output schemas) and consumed by all three consumers. Two
layers, deep-merged, repo wins:

1. **Global:** `~/.foreman/config.json` — the repo map, loop tuning,
   and `repoDefaults`.
2. **Per-repo:** `<repo>/.foreman/config.json` — overrides for that repo,
   versioned with the code it governs.

Sketch (defaults shown; every number quoted elsewhere in this spec is a
default defined here, not a constant):

```jsonc
{
  // global only
  "repos": { "<initiative-id>": "<repo-path>" },          // §3.5 — one per product
  "loop": {
    "wipGlobal": 3,                                       // §17.6
    "wip": { "triage": 1, "refine": 2, "implement": 3, "review": 2 },
    "readyBufferTarget": 5,                               // §17.6
    "backpressureThreshold": 5,                           // §17.7
    "retryCap": 2,                                        // §17.8
    "reviewCycleCap": 2,                                  // §7.4
    "cadenceMinutes": 5,
    "triageWindow": "06:00"
  },
  "triage": { "staleLowDays": 90 },                       // §7.1

  // per-repo (or global "repoDefaults")
  "baseBranch": "main",
  "pr": { "required": true, "draft": false, "ciRequired": true },
  "merge": { "strategy": "squash",                        // merge | squash | rebase
             "deleteBranch": true },
  "branchPattern": "<issue-id>-<slug>",                   // §12
  "worktreePattern": "../<repo>-<ISSUE-ID>"               // §12
}
```

**`pr.required: false` — direct-branch mode.** The workflow shape is unchanged
(one issue → one worktree → one branch), but implement pushes the branch and
opens no PR (`prUrl` stays empty in the `ImplementResult`), review diffs
`baseBranch..head` fetched by the extension (§7.4), the review gate targets the
pushed branch (§10), and Done cannot come from Linear's GitHub PR integration —
the merge-detection worker (§16 item 7) becomes **required** in this mode, not
optional.

**`/foreman-merge <ISSUE-ID>`.** Operator-invoked, never loop-invoked — this
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

---

## 4. Linear data model

### 4.0 Workspace topology (pre-loop setup)

**One team for everything.** Teams are where Linear scopes the machinery:
workflow states, estimate config, the Triage inbox, team labels, and the issue
prefix are all per-team. Everything §4 configures exists exactly once only if
there is exactly one team. Products are differentiated by initiative and
project, never by team. If a product ever outgrows this, Linear sub-teams can
inherit workflow and labels from a parent — a migration path that doesn't fork
config.

**Route the operator's own issues through Triage.** Issues land in Triage only
when created by an integration, from inside the Triage view, or by a
non-member. The operator *is* a member, so self-filed issues — most inbound —
would skip straight to Backlog, bypassing classification, dedupe, and priority
proposals, then permanently fail the refinement gate untyped. Set the team's
default issue template to Triage status so everything enters through one
funnel.

**Initiatives on from day one, and load-bearing.** Initiative = the product
(§4.1); the repo map (§3.5, §3.10) and the product `Context` doc (§4.7) hang
off it. Portfolio groupings (e.g. the weekly micro-products practice) are
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
| Initiative | **The product/app.** Never closes. Carries the repo mapping (§3.5, §3.10) and the product `Context` doc (§4.7). ~1:1 with a repo. Naming-convention parents group a portfolio (§4.0). |
| Project | **A shippable increment** — a feature or milestone that ends — or the product's standing `Maintenance` project. Carries the project brief (§4.7). |
| Issue | Unit of agent work. One issue = one worktree = one PR. |
| Sub-issue | Product of `foreman-refine` splitting an oversized issue. |

The definitional line between initiative and project is lifecycle, not size: an
initiative is a container that never closes, a project is a thing that ships
and closes. A micro-product is a product that happens to take a week — it gets
an initiative like anything else, holding a single `Launch` project.

### 4.2 Workflow states

Linear's native set; no custom states.

| State | Meaning | Moved in by |
|---|---|---|
| `Triage` | Unprocessed inbound. | Linear inbox, operator, integrations |
| `Backlog` | Accepted, not yet refined. | extension, from `TriageProposal` |
| `Todo` | **Refined and ready.** Gate §10 satisfied. | extension, from `RefineResult`; also on block, In Progress → Todo (§9) |
| `In Progress` | Worktree open, code being written. | extension, at implement dispatch |
| `In Review` | PR open, awaiting review. | extension, from `ImplementResult` |
| `Done` | Merged. | Linear's GitHub integration on merge (PR mode); the loop's merge-detection worker when `pr.required: false` (§3.10). The operator does the merging, via `/foreman-merge` or by hand |
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
| `spawns` | Grants the child the `task` tool so it can fan out further. | **`false` on all four.** Recursive fan-out inside a workflow agent is exactly the uncontrolled behavior Foreman exists to prevent. Set explicitly; do not rely on the depth gate. |
| `blocking` | `true` runs the spawn inline; default is a background job whose result is delivered into the parent conversation later. No bundled agent sets it. | `true` only for `foreman-refine` (short-lived; inline is right both when the operator invokes it and in the loop's print-mode parent). Everything else background. |
| `thinking-level` | The agent's effort selector. `auto` does per-prompt classification. Per-spawn `effort` overrides it, but only when `task.enableEffort=true` (default off) — so in practice frontmatter is the real control. | Per agent, §7. Don't rely on `effort` unless you enable the setting. |
| `output` | JSON Schema for structured output. Precedence: per-call `outputSchema` → frontmatter `output` → inherited parent schema. Pair with `schemaMode: strict`. | **Required on all four.** See §6. |
| `advisor` | Pairs the child with an advisor session that raises concerns and blockers mid-run. `on` / `off` / model pattern. Subagents default to none. | `on` for `foreman-refine` only. The advisor interrupts the *agent*, not the operator — it does not violate §9. |
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

Set `schemaMode: strict` on all four. Permissive mode defeats the purpose.

With principle 9, these objects are not just the return channel — they are the
*complete* specification of every mutation the extension applies. Anything an
agent wants changed in Linear must be expressible in its result schema, or it
doesn't happen.

Sketch schemas — refine during build, but keep the shapes:

```
TriageProposal
  items[]: { issueId, type, proposedPriority, severityReasoning,
             duplicateOf?, proposedBlockedBy[], destination,
             reproConfidence, missingInfo[] }
  summary

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
thinking-level: low
advisor: off
prewalk: false
autoload-skills: [foreman-triage-inbox, foreman-block-protocol]
output: schemas/triage-proposal.json
schemaMode: strict
```

| | |
|---|---|
| **Transition** | `Triage → Backlog / Canceled / Duplicate` |
| **Trigger** | The loop's triage worker (§17.5). Never called mid-flow by another agent. |
| **Model role** | `smol` |

No Linear mutation surface of any kind, no `edit`, no `write`, no `bash`.
Read-only by construction. Repro reads resolve the repo via the repo map
(§3.5).

**Per item:** classify (`type:`), dedupe by semantic similarity, attempt repro
*by reading only*, propose a Priority with severity reasoning, flag missing
information, propose native `blocked by` relations, recommend a destination —
including project assignment: a milestone project or the product's standing
`Maintenance` project (§4.0).

**Output:** a `TriageProposal`. The extension writes one comment per item — the
human rendering plus an embedded machine-readable copy of the item — and
applies `agent:proposed`. Nothing else is applied. Operator approves by removing
`agent:proposed`, rejects with `reject: <reason>`.

**Applying approvals is not an agent job.** An approved `TriageProposal` item
already says exactly what to do — applying it is deterministic, so
`/foreman-apply` is extension code, not a re-dispatch of the agent. It queries
issues whose latest Foreman proposal comment has no `agent:proposed` label, no
`reject:` reply, and no later applied-marker comment, and applies each; on
success it writes the applied marker. Everything it needs lives in the comment,
so approval state is derivable from Linear alone — no second store to lose.
(It cannot be an agent anyway: tool allowlists are static frontmatter, so there
is no such thing as an invocation-scoped write grant.) Triage stays read-only
forever.

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
thinking-level: high
advisor: on
prewalk: false
autoload-skills: [foreman-refine-issue, foreman-spike, foreman-block-protocol]
output: schemas/refine-result.json
schemaMode: strict
```

Blocking because it's short-lived — inline is right both when the operator
invokes it deliberately and in the loop's print-mode parent. Advisor on because
refinement quality is where reasoning actually pays, and a second opinion
catching a bad split before implementation is cheap.

1. Verify Priority ≠ `None`. Refuse if unprioritized.
2. Read the product `Context` doc and the project brief (§4.7), Definition of
   Done included.
3. Draft the description in the §13.1 template — returned as
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
thinking-level: medium
advisor: off
prewalk: false
autoload-skills: [foreman-implement-issue, foreman-block-protocol]
output: schemas/implement-result.json
schemaMode: strict
```

Runs **non-isolated** in a Foreman-created worktree (§3.7). `prewalk: false` is
load-bearing here, not a default — see §5. `foreman_github_pr` is the one
mutation tool any agent holds — the PR must exist before yield so the block
protocol can reference it.

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
thinking-level: high
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

---

## 8. Skills

| Skill | Bound to | Produces | Authority |
|---|---|---|---|
| `foreman-triage-inbox` | triage | `TriageProposal` | Propose only |
| `foreman-refine-issue` | refine | `RefineResult` | Applies to one prioritized issue |
| `foreman-spike` | refine, operator | Findings + follow-up issues | Investigation only; no production code |
| `foreman-implement-issue` | implement | `ImplementResult` | Full within acceptance criteria |
| `foreman-review-diff` | review | `ReviewResult` | Advisory only |
| `foreman-block-protocol` | all four | `BlockRecord` | — |

Each skill defines: preconditions (the gate it enforces), required reads,
ordered procedure, the output schema it fills, **stop conditions** (the
enumerated cases requiring §9), and explicit non-goals.

`foreman-implement-issue` must include the **resume procedure** as a first-class
path, not an afterthought: detect existing worktree → read prior
`BlockRecord`/findings and the operator's reply → continue from partial commits.
This is the path both `/foreman-unblock` fresh-spawn fallback (§9) and the
review fix cycle (§7.4) depend on.

`foreman-block-protocol` bound to all four via `autoload-skills` is what makes
the interrupt contract guaranteed rather than discretionary — it is in context
before the agent's first assignment, so there is no path where an agent
improvises its blocking behavior because it didn't think to load the skill.

**Autoloaded skills defeat progressive disclosure.** The SKILL.md body is
injected up front on every spawn whether or not it gets used, so it is paid for
on every run. Keep autoloaded bodies to the procedure itself; push reference
material, examples, and edge-case catalogs into sibling files under the skill
directory that the agent reads on demand. `foreman-block-protocol` in particular
should be short — it is loaded four times over on every workflow pass.

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

**Resuming.** `/foreman-unblock <ISSUE-ID>` (or the blocked drain, §17.4)
records the operator's reply as a comment and clears the `blocked:*` label.
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
`/foreman-status`. Forcing agents to *write down* their confusion is a quality
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
  repo is resolved via the repo map (§3.5, §3.10).
- Worktree path: `../<repo>-<ISSUE-ID>` (e.g. `../plotroom-ENG-142`) —
  default, per-repo `worktreePattern` (§3.10).
- Branch: `<issue-id>-<kebab-slug>` (e.g. `eng-142-fix-triage-dedupe`) —
  default, per-repo `branchPattern`; base branch from `baseBranch` (§3.10).
- Worktrees are disposable but must survive a block. No state outside the
  worktree, Linear, and the PR.
- Cleanup of merged worktrees is a scheduled chore, not an agent responsibility.

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
| `foreman-loop` | Every 5–10 min | Scheduler | — |
| `foreman-triage` run | Daily, early | Loop | — |
| Triage approval | Daily | Operator | ~10 min |
| Blocked drain (`/foreman-status`) | 1–2× daily | Operator | ~15 min each |
| Prioritization / roadmap | Weekly | Operator | ~1 hour |
| Workflow retro | Every 2 weeks | Operator | ~30 min |

Refinement no longer has a cadence row — the loop dispatches it as soon as an
issue has a priority. That makes weekly prioritization the throttle on
everything downstream: nothing gets refined, implemented, or reviewed until the
operator sets a priority, which is exactly where the human judgment belongs.

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
`--seq`, and `--ttl-ms`; the `herdr-plugin.toml` manifest and its `[[build]]`,
`[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`, and `[[link_handlers]]`
entries; `[[startup]]` being one-shot init rather than a supervised service;
plugin panes opened via `plugin pane open --entrypoint` with `overlay`, `popup`,
`split`, `tab`, and `zoomed` placements; actions bindable as `plugin_action`
keybindings; no runtime action or pane registration in the current v1 surface;
plugins running unsandboxed as the invoking user; the `HERDR_BIN_PATH`,
`HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, and
`HERDR_PLUGIN_CONTEXT_JSON` runtime variables; `plugin link` skipping build
commands; reinstall replacing the managed checkout.

**Assumptions to verify during build:**

1. **TTSR propagation into subagent sessions** (§15).
2. Whether plugin-provided `rules/` are discovered identically to project
   `.omp/rules/`.
3. Slash-command namespacing (`/foreman:triage` vs `/foreman-triage`). Hyphens
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

---

## 17. The loop

### 17.1 The loop is a state machine, not an agent

The obvious move is a long-running "orchestrator" agent that watches the board
and decides what to run next. Don't build it. Every routing decision Foreman
makes is already a pure predicate over Linear state — the gate validators in
§10 *are* the routing table. Putting an LLM in that path pays model cost and
adds nondeterminism to something fully determined, and when it misroutes you
get to debug a prompt instead of reading a function.

The supervisor is a plain Node process (`foreman-loop`) that imports the same
validators as the extension, run from cron or launchd. It contains no model
call. When it decides to dispatch, it hands the decision to a Dispatcher
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

- **`PrintDispatcher`** — `omp -p '/foreman-implement ENG-142'`. No
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
and `/foreman-status` ordering — nothing else.

**Terminology collision, and a useful diagnostic.** Herdr's `blocked` means it
recognized an approval or question UI on screen. Foreman's `blocked` means a
`BlockRecord` was written to Linear. They are unrelated, and conflating them
will cost you an afternoon. Better: treat any herdr `blocked` as a **Foreman
bug**. The design says agents never ask questions and never hit approval
prompts, so a recognized approval UI means either the parent session's approval
mode wasn't configured or an agent found a path around the block protocol.
Surface it in `/foreman-status` as an anomaly, not as a normal queue.

Set the dispatched session's approval mode explicitly. Subagents get forced
`yolo`, but the *parent* session herdr launches is interactive and can prompt on
its own tool calls — a second interrupt surface that bypasses `BlockRecord`
entirely if left at defaults.

**Layout.**

| Herdr object | Foreman mapping |
|---|---|
| Workspace | One per repo, matching the product initiative (per the repo map, §3.5). |
| Tab | One per in-flight issue, named for the issue (`ENG-142`). |
| Pane | The agent, `--cwd` set to that issue's worktree. |
| `foreman` workspace | The `foreman-loop` and `foreman-board` panes, plus a scratch tab for short-lived triage/refine/review agents, which need no worktree. |

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

### 17.4 The Foreman board (herdr plugin)

Herdr plugins declare a `herdr-plugin.toml` manifest and run as ordinary
commands in any language. The manifest can declare `[[build]]`, `[[startup]]`,
`[[actions]]`, `[[events]]`, `[[panes]]`, and `[[link_handlers]]`. **`[[panes]]`
opens a terminal interface the plugin owns** — that is the TUI entrypoint, and
it makes the dispatcher's status surface a real screen rather than a chat
command.

Open with `herdr plugin pane open --plugin foreman --entrypoint <id>
--placement <overlay|popup|split|tab|zoomed>`, and bind it to a key in
`~/.config/herdr/config.toml` with `type = "plugin_action"`.

**Where the loop runs.** A pane process is long-lived and herdr's server keeps
it alive across client detach, terminal close, and network loss — so running the
loop in a pane is not just viable, it's better than cron: you can watch it, read
its log inline, and restart it by restarting the pane.

The constraint is narrower than "not in a plugin." It is:

- **The loop must not live in the board's pane.** If the loop and the view share
  a process, closing the board stops the loop. Run two panes — `foreman-loop`
  (the supervisor, §17.5) and `foreman-board` (the view) — or a loop pane plus
  an on-demand popup board. The view is disposable; the loop is not.
- **`[[startup]]` starts the loop pane; it does not *be* the loop.** Startup
  hooks are one-shot initialization commands, not supervised services. Spawning
  a long-lived pane is a one-shot action, so this is exactly the right use: on
  server restore, the startup hook re-creates the `foreman-loop` pane. What runs
  inside it is a normal long-running process.
- **The loop is a singleton.** Take a lockfile in `HERDR_PLUGIN_STATE_DIR` on
  start and refuse to run if another holder is live. Two supervisors racing the
  same board is the one failure mode that corrupts state rather than just
  wasting tokens.

Pane lifetime still ends at reboot or `herdr server stop`. The startup hook
covers server restore; add a launchd/systemd unit only if you want the loop to
survive a reboot without you opening herdr.

**The board is a view, not a control plane.** It renders Linear state and loop
state and invokes the same commands the operator would type. It holds no queue
of its own and caches nothing authoritative. The moment it starts storing
decisions you have three places truth lives — Linear, the loop, and the TUI —
and reconciling them is a worse problem than the one the board solves.

**Build the queues before the dashboard.** The instinct is a pretty board view
first. The board is ambient; the queues are where the operator's time actually
goes, and they're what the whole design is optimized around:

| Screen | Purpose | Priority |
|---|---|---|
| **Blocked drain** | List `BlockRecord`s, show question + options + recommendation, resolve with a keypress — writes the Linear reply and dispatches the resume. | First. Highest value in the system. |
| **Proposal review** | Triage batch with per-item accept/reject, keystroke-driven. | Second. |
| **Board** | Issues by state, per-worker WIP, backpressure status, last run per worker. | Third. Ambient. |
| **Agent detail** | Live agent status, jump-to-pane / attach. | Fourth. |

The blocked drain is the payoff. Today that drain is: read a Linear comment,
decide, write a reply, wait for a resume. As a screen with the `BlockRecord`
already parsed and its options enumerated, it collapses to a list and a
keypress. A 15-minute drain becomes two minutes, which directly raises the
backpressure ceiling the loop can safely run at (§17.7).

Use `popup` placement for the drains — intentionally temporary, leaves the
layout untouched — and `tab` or `zoomed` for the board.

**Events.** `[[events]]` gives a push channel for herdr events: refresh the
board on agent state change, and raise an alarm when an agent enters herdr
`blocked`, which per §17.3 means a Foreman bug rather than a normal queue entry.

**Credentials.** The Linear token goes in `HERDR_PLUGIN_CONFIG_DIR`, never in
the managed checkout — reinstalling a GitHub-sourced plugin replaces that
directory. Note also that herdr plugins are not sandboxed and run as your user
with your environment. Self-authored, that's acceptable; it is still the reason
this plugin holds a write-scoped Linear token and not a broader one.

**Manifest limits worth knowing up front:** actions and panes are declared in
the manifest only — there is no runtime registration in the current v1 surface,
so the screen list is static. `herdr plugin link <path>` registers a live
checkout for development but does not run build commands, so build it yourself
during iteration.

### 17.5 Stage workers

One supervisor process, several independent workers — not one monolithic sweep.
Stages have wildly different durations (refine is minutes, implement can be
hours), so a single cadence and a single WIP number is wrong for both, and a
single sweep means implement starves waiting for refinement to happen in the
same pass.

```
foreman-loop  (one process, one lockfile, N async workers)
  ├─ reaper       every 5 min   — stale locks (§11)
  ├─ triage       daily window  — batch over the Inbox view
  ├─ refine       every 5 min   — top Ready buffer up to target
  ├─ implement    every 5 min   — pull from Ready
  └─ review       every 5 min   — PRs whose head SHA has no ReviewResult
```

Each worker owns one transition and evaluates only its own predicate:

| Worker | Selects | Condition | Dispatches |
|---|---|---|---|
| `triage` | Inbox view | non-empty, daily window | `foreman-triage` (batch) |
| `refine` | Backlog; plus `legacy` in Backlog or Todo (§4.9) | priority ≠ None, no `agent:*` | `foreman-refine` |
| `implement` | Todo | implementation gate passes | `foreman-implement` |
| `review` | In Review | PR open, no `ReviewResult` for head SHA | `foreman-review` |

Nothing is dispatched for an issue carrying `blocked:*`, `agent:proposed`,
`agent:running`, or `agent:hands-off` — every worker checks these first.

**One process, not four.** Independent cadences, but a shared lockfile, shared
global counters, and one place to read logs. Four separate processes multiplies
the singleton problem by four and gives you no shared view of total load.

**Claim before dispatch, not after.** Workers overlap and a slow spawn would
otherwise double-fire. The extension writes `agent:running` with a dispatch ID
first (§11), closing the window; the reaper cleans up spawns that die between
claim and start. The Linear label is the mutex across all workers — that is
what makes concurrent stages safe. Agents verify the ID; they never claim.

**Loop bookkeeping.** Attempt counters (§17.8), review-cycle counters (§7.4),
last-triage-run (so a mid-day loop restart doesn't refire the daily batch),
`reviewedSha` per PR, and dispatch history live in a small SQLite (or JSON)
file in the loop's state dir. Explicitly **non-authoritative** — it is dispatch
bookkeeping, not workflow state, so it does not create a second source of truth
beside Linear. Lost or corrupted, the worst case is one redundant dispatch or
one premature retry; the reaper reconciles it against Linear and the registry
on start.

Poll on a 5-minute cadence. Linear webhooks would be more responsive and are a
reasonable later optimization; nothing here needs sub-minute latency.

### 17.6 WIP limits

Two layers, and the global one is the one that protects you.

**Global cap on concurrent agents. Start at 3.** This governs. The failure mode
of an autonomous loop is generating work faster than the operator can absorb it,
and a low ceiling is the only thing that surfaces that early enough to correct.

**Per-stage sub-limits**, which must sum to more than the global cap or they do
nothing useful — they shape the mix, the global cap sets the volume:

| Worker | Sub-limit | Note |
|---|---|---|
| `triage` | 1 | Batch job; never more than one in flight. |
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
dispatching new work.** Threshold starts at 5.

Backpressure is global, never per-stage. This matters more now that stages run
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

The same rule applies to unapproved proposals. If `agent:proposed` count exceeds
the threshold, skip the triage dispatch — there is no point generating
proposals faster than they're being approved.

Backpressure state belongs in `/foreman-status` so it's visible why the loop
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

### 17.9 Autonomy staging

Do not go from manual commands to a full loop. Each stage runs until it's
boring:

1. **Manual.** Commands only. The loop doesn't exist yet.
2. **Dry run.** `foreman-loop --dry-run` logs what each worker would dispatch and does
   nothing. Run for a week. Read the log every morning. This is where routing
   bugs surface for free.
3. **Read-only auto.** The loop dispatches `foreman-triage` and
   `foreman-review` only. Both are non-mutating, so a bad dispatch costs tokens
   and nothing else.
4. **Full loop.** Add `foreman-refine` and `foreman-implement`, WIP 3,
   backpressure 5.
5. **Herdr dispatcher.** Swap the dispatcher only after the loop is boring on
   print mode. Changing the execution substrate and the routing rules in the
   same week means you won't know which one broke.

Merge authority never enters the loop. The operator merges, at every stage.

Tune WIP and backpressure upward only after a stretch where the blocked queue
consistently drains to zero within a day. If it doesn't drain, the constraint is
the operator's attention, and raising the limits makes throughput worse rather
than better.

---

## 18. Build order

1. **Plugin skeleton + Linear config.** Correct `omp.extensions` key, local
   marketplace install, `/reload-plugins` loop working. The `core` config
   loader with schema validation, layering, and defaults (§3.10). Workspace
   topology per §4.0: single team, default issue template → Triage,
   initiatives enabled, one initiative per product (grouping prefixes where
   wanted), standing `Maintenance` projects, repo map populated. Then Linear
   states, load-bearing labels, `legacy` amnesty pass (including homing
   projectless issues, §4.9), six saved views, one worked product `Context`
   doc + project brief with a Definition of Done. Resolve §16 items 5, 7,
   and 9. ~1 day.
2. **Schemas + extension core + interrupt protocol.** The four result schemas
   and `BlockRecord` union first — everything downstream consumes them. Then
   typed Linear read tools, the result-application layer that makes the
   extension the sole Linear writer (principle 9), gate validators, the lock manager
   (dispatch IDs, claim/release), the lock reaper, the config loader's
   `session_start` validation and repo-map lookup (§3.10), lifecycle listeners,
   `foreman-block-protocol` skill, the skill-name resolution guard (§8), and
   `/foreman-status`. Verify §16 items 1 and 2 here. ~2 days. Build before any
   agent — retrofitted, one agent gets a "just ask the user" fallback and it
   becomes the default.
3. **`foreman-triage`, propose-only + `/foreman-apply`.** Inbox view, applying
   nothing without approval, on cron. ~half a day. **Run it for a week before
   building anything else.** Its bad proposals teach more about where the
   operator's judgment lives than designing the rest up front.
4. **`foreman-refine` + `foreman-spike`.** After triage tuning. ~half a day.
5. **`foreman-implement` + `foreman-review` + the fix cycle + TTSR rules.**
   Shaped by what 3 and 4 revealed. Includes the resume-mode path in the
   implement skill, the findings route with its cycle cap (§7.4), both merge
   modes and `/foreman-merge` (§3.10). ~1.5 days, most of it in worktree
   lifecycle and the fix cycle.
6. **`foreman-loop` + `PrintDispatcher` + autonomy staging (§17).** Supervisor,
   lockfile, bookkeeping file, the four stage workers, global cap and per-stage
   sub-limits, Ready buffer target, backpressure, retry counter, `--dry-run`.
   ~1.5 days. Start with the `implement` worker alone and add the others one at
   a time — four workers introduced together makes a routing bug impossible to
   attribute. Then walk the staging ladder, a week per stage.
7. **`HerdrDispatcher` (optional).** Workspace/tab/pane layout, agent naming,
   sidebar tokens, attach path, print-mode fallback. ~half a day. Only after
   step 6 is boring.
8. **Herdr plugin + board TUI (§17.4).** Manifest, then the blocked drain
   screen, then proposal review, then the board. ~2 days. Ship the blocked
   drain alone and use it for a week before building the rest — if it doesn't
   measurably shorten the drain, the remaining screens won't either.

Roughly 8.5 focused days of build, spread across several weeks of observation
windows. The waiting is the point; compressing it is how you end up with a loop
that dispatches confidently into a routing bug.

---

## 19. Non-goals

- Auto-merge on clean review, at any autonomy stage
- An orchestrator *agent* — routing is a pure function (§17.1)
- Agents holding Linear or GitHub write tools (implement's `foreman_github_pr`
  excepted) — the extension is the sole writer (principle 9)
- An uncapped review→fix cycle (§7.4)
- A loop that dispatches without a WIP limit or backpressure
- Herdr agent state as a routing input (§17.3)
- The loop sharing a process with the board TUI (§17.4)
- More than one supervisor running at a time
- The board TUI holding authoritative state of its own
- A board/dashboard screen before the blocked drain screen
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
- An `area:` ontology beyond what `foreman-implement` reads
- Publishing to a public marketplace before it works locally
- Config keys that can disable gates, WIP limits, backpressure, the lock
  protocol, or propose-before-apply — config tunes parameters, never removes
  invariants (§3.10)
