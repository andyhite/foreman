# Verified during build

`SPEC.md` §16 lists ten assumptions to verify while building, and §18 assigns
them to build steps. This is the answer sheet. Where an answer contradicts the
spec, the code follows the answer and the discrepancy is called out — the spec
was written against documentation, and some of it was wrong.

## §16 assumptions

| # | Assumption | Answer | Evidence |
|---|---|---|---|
| 1 | TTSR rules propagate into subagent sessions | **Yes** | A throwaway rule (`condition: BANANAPHONE`, `scope: text`) was discovered at `native` priority, then a `sonic` subagent spawned through the `task` tool wrote the token and its stream was aborted and corrected mid-run: the child's final output was the rule's injected instruction. Measured, not inferred. |
| 2 | Plugin `rules/` are discovered like project `.omp/rules/` | **Yes**, at provider priority 90 | The `omp-plugins` provider reads `rules/*.{md,mdc}` inside extension package roots through the same `buildRuleFromMarkdown` path. Native (`.omp/rules/`, `~/.omp/agent/rules/`) is 100, so a same-named user rule shadows a plugin rule first-wins. The `foreman-` prefix is what keeps that from happening by accident. |
| 3 | Slash-command namespacing | **`/foreman:<name>`, but not automatically** | The evidence this row originally cited was wrong: omp's `omp-plugins` provider (what `omp-plugins.lock.json` — the file `activateRepoPlugin` wrote alone at the time — feeds) never namespaces a command; `discovery/omp-plugins.ts`'s `loadSlashCommands` uses the bare file stem unconditionally, so `commands/refine.md` was live as `/refine`, not `/foreman:refine`. Only the `claude-plugins` provider prefixes with `<plugin>:<file-stem>`, and it discovers plugins from a different file entirely: `<repo>/.omp/plugins/installed_plugins.json`, keyed by a `<name>@<marketplace>` id. Because Foreman never wrote that file, every dispatcher (`PrintDispatcher`, `HerdrDispatcher`) built a `/foreman:refine ENG-1`-shaped prompt that matched no registered command, and the dispatched session fell through to unexpanded literal text — it improvised by reading the `foreman-refine-issue` skill itself instead of running `commands/refine.md`'s `task`-dispatch template. Fixed: `activateRepoPlugin` now also upserts a `"foreman@foreman"` entry into `installed_plugins.json`, pointing at the same symlink. That entry makes `listOmpExtensionRoots` exclude the plugin's `omp-plugins.lock.json` root from its own list (it matches the `installed_plugins.json` root by realpath), so `claude-plugins` becomes the sole discoverer of the plugin's skills/rules/commands/hooks/tools — verified against omp 18.1.5: `omp ttsr list` tags all three Foreman rules `[claude-plugins]` with no duplicates, and an ACP `available_commands_update` probe shows `foreman:plan`/`foreman:refine`/`foreman:roadmap`/`foreman:implement`/`foreman:review`/`foreman:triage` with the bare forms gone. The extension module (the actual tools) is unaffected — it loads through the lock file directly, never through `listOmpExtensionRoots` — confirmed live: `foreman_linear_read` kept working, and a fresh `omp -p '/foreman:refine <id>'` run now shows the *expanded* command template as the session's first user message, not the literal slash text. |
| 4 | Can a pre-tool hook hard-fail a call, or only observe? | **Hard-fail** | `tool_call` handlers may return `{ block: true, reason }`, and a handler that throws blocks the tool anyway (`tool_call` errors are fail-closed). They may also return `{ input }` to revise the arguments the tool executes with. The `tools` allowlist is therefore *not* the sole enforcement — see the note on `schemaMode` below. |
| 5 | Can Linear filter a saved view on *incomplete* blocking relations? | **No** | `IssueFilter` has `hasBlockedByRelations`/`hasBlockingRelations` taking `RelationExistsComparator { eq, neq }`, which answers "has any blocked-by edge" and nothing about the blocker's state. Completeness must be evaluated in code from the relation's `other.state.type`. Views 2 and 3 stay separate as §4.10 recommends; `BLOCKED_DEPS_FILTER` narrows and `incompleteBlockers()` finishes the job. |
| 6 | The bundled agent roster | `scout`, `designer`, `reviewer`, `security-reviewer`, `librarian`, `task`, `sonic` | `reviewer` and `designer` are both real, so an agent named `reviewer` would shadow a bundled one globally. Every Foreman agent is prefixed. |
| 7 | Does Linear's GitHub integration auto-transition to Done on merge? | **Only with setup** | The transition is a team-level workflow automation, not default behavior, and when two or more PRs link to one issue all must merge. Foreman cannot rely on it, so the merge-detection worker is required rather than optional — `loop.mergeDetection` defaults to `true` in both PR and direct-branch mode. |
| 8 | Frontmatter tool spellings, and `output:` path resolution | **Tools: corrected. Path: never resolves — inline instead** | There is no `search` tool (it is `grep` + `glob`) and no `dap` tool (it is `debug`); `exec` is an expansion alias for `eval` + `bash`, and the agents list those two explicitly. A frontmatter `output:` **string is `JSON.parse`d, not read as a path**: a probe carrying `output: schemas/probe.json` failed preflight with `Invalid strict effective output schema: JSON Parse error: Unexpected identifier "schemas"`. The schema must therefore be **inlined in the frontmatter**, which is what the agents ship — as a YAML block scalar (`output: \|`) holding pretty-printed JSON, generated into the file by `packages/core/scripts/emit-schemas.ts` so the TypeBox definition in `core` stays the single source of truth. Verified end to end: `foreman-triage` with its 11 KB inlined schema passed preflight and a child under `schemaMode: "strict"` returned a valid envelope (`{"blocked": false, "result": {"items": [{"issueId": "ENG-1", "type": "type:bug", …`) with no validation error. The sibling `schemas/*.json` files remain as human reference. |
| 9 | Do documents attach at the initiative level? | **Yes — the fallback is unnecessary** | `Document` carries `initiative: Initiative` alongside `project: Project` and `issue: Issue`, and `Initiative` carries `documents: DocumentConnection`, `content: String`, and `documentContent: DocumentContent`. Introspected against the live API. §4.7's contingency — pinning the product `Context` doc in the standing `Maintenance` project — is therefore dead weight and is not implemented. |
| 10 | Linear project↔team semantics for the ensure pass, and can issues be queried by team + initiative in one hop | **Team required; initiative attachment is a second mutation; one-hop query works** | `ProjectCreateInput` has exactly two non-null fields: `name: String!` and `teamIds: [String!]!` — creating a project requires an explicit team and there is no `initiativeId` field on the input. Attaching the created project to an initiative is a separate mutation, `initiativeToProjectCreate(input: { projectId: String!, initiativeId: String!, sortOrder: Float })`, returning `{ success }`; callers must handle the window between the two calls. `Initiative.projects: ProjectConnection` is a direct edge (the read-side mirror of `Project.initiatives`). For querying, `NullableProjectFilter.initiatives: InitiativeCollectionFilter` exists and executes: `issues(filter: { project: { initiatives: { some: { id: { in: [...] } } } } })` returns results in one hop — no need to resolve the initiative's projects first. All introspected and executed against the live API this session. |

## Where the spec is wrong

These are corrections, not preferences. Each one would have produced a silently
broken plugin.

**`structuredOutput` is `{ source, mode, status, data }` — there is no `valid`
boolean.** `status` is `"valid" | "invalid" | "unavailable"`. The extension's
shape guard originally required `typeof value.valid === "boolean"`, so it
rejected every genuine payload and `extractFromToolResult` skipped each result
as "not structured output": agents yielded, validated fine, and nothing was
ever written to Linear for any stage. Measured twice — off a recorded
`SingleResult` in a session transcript, and live from a probe agent spawned
during the fix:

```json
{ "source": "agent", "mode": "strict", "status": "valid", "data": { "verdict": "GREEN" } }
```

**Only a synchronous spawn's result reaches the extension.** `structuredOutput`
exists on the `SingleResult` alone, and a `SingleResult` reaches the parent
only inside the `task` tool's `tool_result` (`result.details.results[]`). With
`task.async.enabled` on, a non-`blocking` agent spawns as a background job:
the immediate `tool_result` carries only the spawn acknowledgement, and the
settled result is delivered later as an `async-result` custom message whose
`details` is `{ jobs: [{ jobId, type, label, durationMs }] }` — prose content,
no structured data, nothing to apply. Every workflow agent therefore declares
`blocking: true` (SPEC §3.5 item 5), which contradicts the `blocking: false`
§7 frontmatter blocks as originally written.

**The `task:subagent:*` channels are not a capture fallback.** All three
payloads are status only — `{ id, agent, parentToolCallId, detached,
agentSource, description, status, sessionFile, index }` — with no task text and
no `structuredOutput`, so an extractor probing them structurally can never
fire. The extension listened on them as a second channel, which made the
capture path look redundant while it was in fact broken end to end; the
listeners are gone and SPEC §3.5 item 7 now scopes those events to status and
abort detection.

**`schemaMode: strict` is not an agent frontmatter key.** §5 and §7 put it in
every agent's frontmatter. It is a *per-spawn* field on the `task` tool item and
defaults to `permissive`; in frontmatter it is inert, so every Foreman agent
would have run with permissive validation — exactly the outcome §6 says defeats
the purpose. Enforcement moved to `src/enforce/task-guard.ts`, which intercepts
`tool_call` for `task` and forces `schemaMode: "strict"` onto every `foreman-*`
item. This is strictly better than frontmatter would have been: the same
interceptor also evaluates the gate, claims the lock, and prepares the worktree,
so "claim before dispatch" (§17.5) and the gate check (§10) became structural
rather than conventional, and `foreman-no-gate-bypass` shrank to a narrow
backstop over shell access instead of carrying the whole burden.

**`output` must be inlined, so the two halves of the contract live apart.** The
schema is in the frontmatter (generated); the validation *mode* is set by the
interceptor, because it is the one thing frontmatter cannot carry. That split is
deliberate and worth remembering: editing `packages/core/src/schemas/*.ts` then
running `bun run schemas` is the only correct way to change an agent's contract.
Setting a per-call `outputSchema` would silently outrank the frontmatter and hide
whether the inlined schema still works, so nothing does.

**`spawns: false` is not a documented value.** `spawns` accepts `'*'`, a CSV, or
an array, and declaring it *auto-adds* the `task` tool. Setting it to `false`
risks granting the very thing §5 forbids. The real mechanism is omitting both
`spawns` and `task` from an explicit `tools` allowlist, which is what the agents
do, with a YAML comment saying so.

**The manifest lives at `.omp-plugin/plugin.json`.** §3.1 said
`.claude-plugin/plugin.json`; that is the Claude Code fallback. The omp-native
location is `.omp-plugin/`. (§3.1 has since been corrected.) That manifest is
now gone entirely: a hand-written project plugin root needs no manifest at
all. Discovery unions the dependency map with the lock file's own entries, so
a lock-only entry — `<repo>/.omp/plugins/omp-plugins.lock.json` naming
`@foreman/omp-plugin`, with no `package.json` alongside it required in the
plugin root itself — is sufficient. Verified against omp 18.1.4 by driving
`omp acp` (`initialize` + `session/new`) in a scratch repo and reading the
`available_commands_update` notification: `foreman:merge`, `foreman:status`,
`foreman:unblock`, the markdown commands `plan`, `refine`, `implement`,
`triage`, and all `skill:foreman-*` entries appeared, and
the process debug log showed all three foreman TTSR rules registered
(`foreman-no-gate-bypass`, `foreman-no-interactive-questions`,
`foreman-no-scope-expansion`). So the extension module, `skills/`,
`commands/`, and `rules/` all load from a project-scope link with nothing
more than the two files above.

**Project plugin-root resolution walks up from the process cwd, unlike omp
settings discovery.** The same probe run from `<repo>/sub/deep` loaded
everything identically to running it at the repo root. This differs from omp
*settings* discovery, which is cwd-only and does not walk ancestors — a
distinction worth keeping straight, because it means a plugin stays active
from any subdirectory while a settings override does not.

**Symlink chains resolve, which is what lets one global indirection serve
every repo.** `<repo>/.omp/plugins/node_modules/@foreman/omp-plugin ->
~/.foreman/plugin -> <checkout>/packages/omp-plugin` loaded identically to a
direct link in the same ACP probe. `foreman setup` writes the middle link
once; every repo's `foreman init` writes only the first hop.

**A broken symlink target degrades gracefully.** Pointing the repo-side link
at a nonexistent target and starting a session did not crash it: the session
still started and Foreman was simply absent, no error surfaced. `foreman
verify` is what turns that silence into a diagnosis.

**`omp plugin link <dir> --scope project` silently ignores `--scope` and
installs user-wide — the footgun this design exists to avoid.** Verified
against omp 18.1.4: the command reports `✔ Linked @foreman/omp-plugin from
<dir>`, writes nothing into the project, and adds an entry to
`~/.omp/plugins/omp-plugins.lock.json` instead — the exact machine-wide leak
that would make Foreman's rules, skills, and agents fire in every repo on the
machine, not just the ones registered in `config.repos`. `--scope` is honored
for a marketplace install (`name@marketplace`) alone. This is why activation
writes the project plugin root directly instead of calling `omp plugin` at
all — there is no `omp` invocation that reaches project scope from a local
directory.

**A gitignored `dist/` shipped a plugin whose extension never loaded — this
is the failure the old marketplace-based install carried, now retired.** `omp
plugin install <name>@<marketplace>` copied the plugin directory out of a git
clone of the marketplace repo and symlinked it into the scope's
`node_modules`; it never ran a package manager and never built. `package.json`
pointed `omp.extensions` at `./dist/extension.js` while `.gitignore` excluded
`dist/`, so every repo that installed Foreman the normal way got a plugin
with no extension entrypoint at all — and omp includes a declared entry only
if the file exists, dropping a missing one without a warning. The failure was
especially convincing because `agents/`, `commands/`, `skills/`, and `rules/`
are auto-discovered straight from the copied tree: `/foreman:plan` expanded
its prompt exactly as designed while both tools, the task guard, the lock
manager, and the result appliers were absent. Confirmed by A/B: in a repo
whose install lacked the bundle the agent reported no `foreman_linear_read`
in any form, and the same repo loaded and called it top-level once given a
copied tree that carried `dist/extension.js`. The fix at the time was to
commit the bundle; that fix has since been superseded (below) rather than
kept, because committing it only patched this one symptom of the marketplace
distribution path, not the path itself.

**The version-keyed marketplace plugin cache served stale code indefinitely —
the concrete reliability failure that motivated dropping the marketplace path
altogether.** `~/.omp/plugins/cache/plugins/foreman___foreman___0.1.0/` was
observed holding an older build than the working tree: `dist/extension.js`
and five `src/` files differed, and `src/lock/manager.ts` existed only in the
cache, not in the checkout. Because the plugin version was pinned at `0.1.0`
and the catalog declared no `version`, `omp plugin upgrade` compared versions,
found no change, and no-opped — so the cache served whatever it first cached
forever, with no way to force a refresh short of deleting the cache
directory by hand. `foreman update`'s new design has no cache to strand:
every repo's plugin symlink resolves through the single global
`~/.foreman/plugin` link straight to the checkout, so rebuilding the checkout
is the only "upgrade" step there is.

**`omp plugin list --json` reports nothing at all for a project-scope
link — it only reads the user plugin root and the marketplace registries.**
Probing it to decide whether a repo is activated therefore reports a healthy,
fully-activated repo as uninstalled, which is exactly what the old
`findPluginScopes` code did and exactly why it was wrong: `foreman update`
used to surface "no project install; run `foreman init` there" against a
repo that had just been initialized. (The table-vs-`--json` parsing footgun
below was a second, independent bug in that same dead code path — worth
keeping as a cautionary note about parsing `omp plugin list` output at all,
not just about the column it targeted.) Activation state is no longer read
from `omp`; `inspectRepoActivation` in `plugin-activation.ts` reads the
repo's own lock file and resolves its own symlink instead.

**`omp plugin list` prints the scope parenthesized, so only `--json` can be
parsed**, and even `--json` misses project-scope installs (above): the table
renders one line per install as `  foreman@foreman (0.1.0) (project)` — id,
then version in parentheses, then the scope in parentheses, dim-styled, with
an optional ` [shadowed]`. A parse that looked for a bare `project` column
matched nothing and reported every healthy install as absent. `--json`
returns `{ npm, marketplace }`, where `marketplace` holds one element per
(plugin id, registry) pair — `{ id, scope, entries }`, the user element
carrying `shadowedBy: "project"` when both exist — so a plugin installed at
both scopes appears twice under one id and each element states its own
scope, when the plugin was marketplace-installed at all. Verified against
omp 18.1.4 by A/B on live output from a project-installed repo: the column
parse returned `{ project: false, user: false }` and the JSON parse
`{ project: true }`.

**`omp plugin uninstall <pkg>` removes the lock entry but leaves the
`node_modules/<pkg>` symlink behind.** Verified against omp 18.1.4: a full
cleanup has to delete that symlink itself, which is why `deactivateRepoPlugin`
removes both the lock entry and the `node_modules/@foreman/omp-plugin`
symlink rather than leaning on any `omp plugin` command to do it.

**omp replaces an extension's bare `@sinclair/typebox` with its own shim, and
the shim rejects `default: {}`.** Bisected with one-file probe extensions: a
trivial `.ts` extension loads, and one registering a tool with `.default(50)`
loads, so TypeScript entrypoints are genuinely supported and our own tool
schemas are fine. A probe whose only statement is `import { AGENT_LABEL } from
"@foreman/core"` fails with `ParseError: A mutable default value must be
specified as a factory`, thrown by `rejectMutableStaticDefault` in
`@oh-my-pi/omptype/src/type.ts`. `config/schema.ts` sets `default: {}` on
eleven schemas; real TypeBox 0.34.52 treats that as inert JSON Schema metadata
and emits it unchanged. The substitution is provable independently: a probe
importing `@sinclair/typebox` resolves under omp and throws, while plain `bun
run` on the same file cannot resolve the package at all — omp is supplying it.

**The remap covers the bare specifier only, and a probe with real installed
dependencies proves both halves.** A self-contained package declaring
`@sinclair/typebox` in `dependencies`, with `bun install` actually run, loads
as an extension and imports it — so the docs are right that extensions may use
runtime dependencies. Inside that same graph the root import is still omp's
shim: `JSON.stringify` of a shim schema returns `undefined`, real
`Value.Check` on one throws `Unknown type`, and `Value.Default` crashes,
because `@sinclair/typebox/value` is *not* remapped — the filter is
`/^(?:@sinclair\/typebox|typebox)$/`. Switching the root import to the subpath
`@sinclair/typebox/type` makes all four behaviors correct: `default: {}`
accepted, JSON-serializable, `Value.Check` true, `Value.Default` populating.
So the shim is escapable, and the earlier claim that vendoring could not help
was wrong.

**That was not why the bundle existed, and the finding is now superseded —
the plugin has no build step at all.** The bundle used to exist because a
marketplace install ran no package manager — the installed copy had no
`node_modules` at all. That premise is gone: every repo's plugin symlink now
resolves through `~/.foreman/plugin` straight to the checkout, a normal
workspace with `node_modules` at its root. Rather than keep bundling to
route around the TypeBox shim, `omp.extensions` now names
`./src/extension.ts` directly and omp loads it as TypeScript with no build
step and no artifact.

**A `./src/extension.ts` entry loads and registers everything, with no
measurable startup cost.** Loaded over ACP against omp 18.1.4 from a repo
with `dist/` deleted: all three extension commands
(`foreman:status|merge|unblock`) and all eight skills registered.
End-to-end session startup was indistinguishable from the old bundled
entrypoint — medians 6.53s source vs 6.75s bundled, both within the
5.0–7.0s run-to-run variance observed across repeated runs.

**omp's remap only ever touches the bare specifier — it never reaches into
`node_modules`.** A probe extension with a deliberately broken
`node_modules/@sinclair/typebox` symlink still loaded successfully, proving
the bare `@sinclair/typebox` import is served entirely by omp's shim and
never resolves through the filesystem. The `@sinclair/typebox/type` subpath
import in the same probe reached real TypeBox and returned a plain JSON
Schema object with a working `.properties`, an accepted `default: {}`, and a
`JSON.stringify` that succeeds.

**omp's facade returns a validator function, not a schema object.** The bare
`@sinclair/typebox` import's result has its own enumerable keys — `ir,
hasSteps, hasDefault, defaultValue, defaultOutput, hasDefaultOutput,
errorConfig, clone, run, $` — plus a `safeParse` method, with no
`.properties` anywhere on it, and `JSON.stringify` throws.

**`pi.zod`, `pi.arktype`, and `pi.typebox` are injected members of `pi`, not
importable modules.** omp exposes native omptype as `pi.arktype`, a
zod-compatible omptype-backed wrapper as `pi.zod`, and the legacy TypeBox
shim as `pi.typebox`, all attached to the `pi` object handed to a live
extension rather than published as packages. Foreman's two tools already
build their parameters with `pi.zod`.

**A malformed frontmatter scalar silently strips a command's whole
frontmatter.** `commands/triage.md` shipped
`argument-hint: [--stale-low-days <days>] <ISSUE-ID...>`, which YAML reads as a
flow sequence followed by unexpected tokens. omp logs one `Failed to parse YAML
frontmatter` warning and drops the block entirely: the description and argument
hint vanish, and the `---` fence leaks into the prompt body the agent receives.
`check-contract.ts`'s `readFrontmatter` is deliberately not a YAML parser and
read the file happily, so the contract check passed a file omp rejected. It now
parses every discovered markdown frontmatter with `Bun.YAML.parse`.

**`autoload-skills` is spelled `autoloadSkills`.** Kebab-case keys are
normalized to camelCase, but the documented agent-frontmatter field name is the
camelCase one, and an unknown key is dropped in silence — the same failure mode
§8 warns about for unknown skill *names*.

**`advisor` is a boolean or a model pattern**, not `on`/`off`. `foreman-refine`
sets `advisor: true`.

**A root-level schema union is unsafe.** §6 calls for "a union of the normal
result and `BlockRecord`". omp's schema normalizer collapses a residual root
`anyOf` to `{ type: "object", properties: {} }` on the Google and
Cloud-Code-Assist paths, which would discard the entire contract without
erroring. Each agent's `output` is instead a flat envelope —
`{ blocked, result | null, block | null }` — preserving the discriminated-union
semantics while surviving every normalizer. `parseAgentOutput` enforces the
"exactly one branch populated" invariant that JSON Schema cannot express.

**There is no `foreman-loop` binary, and the supervisor/`repo`/`team` naming
this row originally recorded is itself superseded.** §17 (pre-simplification)
named a `foreman-loop` binary in eight places, written before the spec had a
`foreman` CLI at all; the first fix made it the `repo`/`team` subcommands of
`foreman`. The loop simplification replaced that pair of long-lived
processes with three: `foreman build`, `foreman plan`, `foreman reconcile`
(§3.11, §17.1), each parsing every argument after its own name. The log
prefix and the herdr pane label (§17.3) track those three names.

## Verified runtime facts worth keeping

- Print mode: `omp -p --approval-mode <always-ask|write|yolo> --cwd <dir> '<prompt>'`.
  The approval-mode flag must be passed explicitly (§17.2) — the print-mode
  parent is a second interrupt surface and stalls headless at defaults.
- `omp ttsr test -r <rule> --source text|thinking|tool [--tool <name>] '<snippet>'`
  exercises one rule in isolation. All three Foreman rules were checked against
  both a true positive and a plausible false positive this way; §15's warning
  about noisy prose regexes is real, and the first draft of
  `foreman-no-gate-bypass` fired on `grep -rn 'agent:running'` — a command an
  implement agent working on Foreman itself would legitimately run.
- Tool parameter schemas are built with `pi.zod`. `pi.typebox` is documented as a
  legacy shim but is absent from the type surface actually shipped; nothing in
  the plugin depends on it.
- **An extension tool that does not set `loadMode: "essential"` is hidden from
  the model's tool list.** Extension registrations default to
  `loadMode: "discoverable"`, and omp's `tools.xdev` layer (default on) moves
  every discoverable tool out of the tool list into an `xd://` device, in any
  session that holds `write` without naming the tool in an explicit allowlist.
  A dispatched loop session running `/foreman:*` is exactly that shape, so both
  Foreman tools were mounted as `xd://foreman_linear_read` and
  `xd://foreman_github_pr` while every command, agent, and skill told the
  caller to use the bare name. The first `/foreman:plan` dispatch spent its
  opening turns reasoning *"I don't see a `foreman_linear_read` tool in my
  available list"* and never reached Linear. Subagents hid the bug: the four
  read-only agents are granted no `write`, so xdev never engages for them, and
  `foreman-implement` names both tools in its frontmatter, which pins them
  top-level regardless. `essential` also restores the full parameter schema in
  the prompt — `tools.xdevDocs` defaults to `"builtins"`, which gives an
  external device a one-line summary and no schema. `check-contract.ts` now
  fails on any registration that is not `essential`.
- Linear personal API keys go in `Authorization: <KEY>` with **no** `Bearer`
  prefix. OAuth tokens take `Bearer`.
- `IssueRelation.type` is `String!` when read and the `IssueRelationType` enum
  when written. There is no `blockedBy` relation type — "blocked by" is a
  `blocks` edge seen from the other end, which is why `IssueRelation` carries an
  explicit `direction`.
- `Project.initiatives` is an `InitiativeConnection`, not a scalar edge: Linear
  genuinely permits a project under several initiatives, so §4.0's "exactly one
  initiative per project" is ours to enforce and cannot be delegated to the API.
  `projectInitiative()` rejects on both 0 and >1, naming the initiatives found.
- **`IssueFilter` has no *direct* initiative field, but filtering issues by
  initiative is still one hop.** Only `project: NullableProjectFilter` exists
  on `IssueFilter`, and `ProjectFilter.initiatives` exists on the project side —
  but `NullableProjectFilter.initiatives: InitiativeCollectionFilter` also
  exists and executes, so `issues(filter: { project: { initiatives: { some: {
  id: { in: [...] } } } } })` filters issues by initiative through the project
  edge in a single query. (An earlier pass of this file claimed this needed
  two queries — resolve the initiative's projects, then filter issues by that
  project set. That claim was wrong; it was never executed against the live
  API.) Repo resolution still caches the project→initiative edge per client,
  which remains true independent of this correction — it serves
  `projectInitiative()`'s single-initiative validation (below), not issue
  filtering.
- **`projectCreate` requires `teamIds`.** `ProjectCreateInput` has exactly two
  non-null fields, `name: String!` and `teamIds: [String!]!`; there is no way
  to create a project without assigning it to at least one team. This is why
  the ensure pass's `Maintenance` project is created team-assigned rather than
  initiative-assigned.
- **`ProjectCreateInput` has no `initiativeId`; attaching an initiative is a
  second mutation.** `initiativeToProjectCreate(input: { projectId: String!,
  initiativeId: String!, sortOrder: Float })` returns `{ success: Boolean! }`
  and must run after `projectCreate` succeeds — there is a window between the
  two calls where the project exists without its initiative.
- **`Initiative.projects: ProjectConnection` is a direct edge**, symmetric with
  `Project.initiatives` (above): reading an initiative's projects is one
  query, no fan-out needed.

## Verified building shared stage orchestrators

- **`herdr agent get <name>` puts the status at `.result.agent.agent_status`,
  not `.result.status`.** The response is
  `{ result: { type: "agent_info", agent: { name, agent_status, pane_id, tab_id,
  workspace_id, cwd, agent_session, ... } } }`, and `agent list` returns the same
  records under `.result.agents[]` (with `name` absent for an agent started
  without an alias). The dispatcher's `status()` read `.result.status`, which is
  always `undefined`, so its switch fell through to `default` and **every herdr
  dispatch reported `running` forever** — including inside `reconcile`, where a
  handle that always looks live keeps its in-flight record until the TTL expires.
  Measured against a live server, not inferred from docs.
- **`agent wait` with no `--until` matches `idle`, `done`, or `blocked`; an
  interactive omp session never reaches `done`.** It goes to `idle` when its
  turn ends and only reports `done` once the process exits, which a session
  herdr launched interactively does not do on its own. `settle()` waited
  `--until done` alone, so it could only ever end at its own timeout
  (`maxRuntimeMs + lockTtlMarginMs`, ~2.5 h by default) rather than when the
  agent finished. Waiting on `idle` as well is what makes a batch's completion
  observable.
- **`agent prompt` does not reject a `working` target and does not track
  turns.** Its own help says so: submission is refused only when the agent is
  `blocked` (`agent_blocked`), and "if the agent is already working, that active
  turn's completion may match" the `--wait` state. omp delivers the submission
  as a queued user message that **interrupts the current turn's in-flight tool
  calls** — observed directly: parallel tool calls in an active turn came back
  as "Skipped due to queued user message". A shared orchestrator must therefore
  be prompted only when `agent get` reports `idle` or `done` (§17.4).
- **`agent explain` reports `screen_detection_skip_reason:
  full_lifecycle_hook_authority` for an omp agent.** omp reports its lifecycle
  to herdr through a hook rather than being screen-scraped, so for `--kind omp`
  the state model is authoritative rather than heuristic. That does not change
  §17.3's rule — herdr state still drives no routing decision — but it is why
  the busy check in §17.4 can be trusted to gate a prompt.
- **A sync `task` batch is concurrent, not serial.** With every item's agent
  declaring `blocking: true` the whole call runs inline, and the items are still
  bounded only by the session-scoped semaphore that async job bodies share
  (`task.maxConcurrency`, 32 on the build machine): "lifecycle, revival, and
  concurrency semantics match N parallel single calls". One prompt therefore
  buys N concurrent agents and N `SingleResult`s in one `tool_result`, which is
  the mechanism §17.4 rests on.

## Verified building the `agent.herdrLayout: "pane"` strategy

- **A pane split only ever divides the one pane it names — it can never
  re-parent a sibling that already exists beside it.** Measured live against
  `herdr` 0.8.2 with `pane layout`'s `splits`/`panes` trees. Splitting an
  existing tab's root pane *right first*, then splitting its *left* child
  *down*, leaves the right pane at `height: 100` throughout — a later split
  inside one child's subtree never touches its sibling's rect. But splitting
  a pane *right* that already has a same-width sibling stacked *below* it
  (i.e. two panes already share one `down` root split) only opens the new
  pane beside the one it was called on, at that pane's own height; the
  existing sibling keeps spanning the full tab width underneath it — two
  panes now sit to the right of one, not a single column spanning both.
  `agent.herdrLayout: "pane"`'s full-tab-height column is therefore only
  guaranteed when its first split runs before anything else in the tab has
  been split — in practice, when the loop's own pane is still the tab's sole
  occupant at that moment.
- **`pane move <id> --tab <same-tab> --split right` with no `--target-pane`
  is a no-op against its own tab**, returning `"changed": false, "reason":
  "same_tab"`. There is no CLI operation that takes an already-multi-pane
  tab and wraps its whole existing tree as one child of a fresh top-level
  split — confirming the limitation above is a real gap in the exposed API,
  not a workaround Foreman failed to find.
- **`pane rename <id> <label>` sets a `label` field that `pane list`,
  `pane get`, and `pane split`'s own response all echo back**, and it
  survives independently of any herdr *tab* label. `agent.herdrLayout:
  "pane"` uses it to find a stage's row pane (`foreman-<stage>`) within one
  shared tab across process restarts, the pane-scoped equivalent of how
  `agent.herdrLayout: "tab"` finds a stage's tab by its own label.

## Verified capturing a `tool_result`

- **`tool_result` carries `details` flat on the event. There is no enclosing
  `result` field.** Measured off the live runtime with a probe hook that
  logged `Object.keys(event)`:
  `["type", "toolName", "toolCallId", "input", "content", "details", "isError"]`,
  with `details` holding `{ projectAgentsDir, results, totalDurationMs, usage,
  outputPaths }` and each `results[]` entry the documented `SingleResult`
  (`structuredOutput` among its ~30 fields). The plugin read
  `payload.result.details.results`; `payload.result` is `undefined`, so the
  extractor iterated an empty array and **captured nothing for any stage,
  ever** — the agent yielded a valid result, the operator saw a clean run, and
  Linear was never written. `src/omp-runtime.d.ts` is what hid it: the
  hand-written declaration promised `result: ExtensionToolResult`, so the
  wrong access typechecked, and every test built payloads in that fabricated
  shape. A/B on one real event: reading `event.details` captures the result
  with its dispatch id and parsed `data`; reading `event.result.details`
  captures zero.
- **A revised `tool_call` input *is* visible on the later `tool_result`.** A
  hook that appends a marker to `input.tasks[].task` and returns `{ input }`
  sees the appended marker in `tool_result`'s `input`, so keying a capture on
  a marker the guard injects is sound — this was the other candidate
  explanation for the silence, and it is ruled out rather than assumed.
- **A background (non-`blocking`) spawn's `tool_result` carries
  `details.results: []`** and an `async` marker in `details`, confirming from
  the other direction why every Foreman agent must declare `blocking: true`
  (§3.5 item 7): the `SingleResult` — and with it `structuredOutput` — exists
  only for an inline spawn.

## Verified writing issues to Linear

Every GraphQL document Foreman sends is now validated against Linear's own
schema, fetched by introspection and checked with `graphql`'s `validate` -
read-only, so mutations are covered as safely as queries. That pass found
three documents the API would reject outright, none of which any test could
see, because every fake answered without ever looking at the query text.

- **`Team.workflowStates` does not exist. The field is `Team.states`.** Linear
  rejects the whole document with a 400 - `Cannot query field
  "workflowStates" on type "Team". Did you mean "draftWorkflowState",
  "mergeWorkflowState", or "startWorkflowState"?` - so `workflowStates()`
  threw on every call, and with it **every `moveToState`**: refine's move to
  Todo and review's move back to Todo could never have run against the real
  API. `linear.test.ts` now asserts the document names `states`.
- **`Document.content` is a `String`.** Both `*_QUERY_OBJECT_CONTENT`
  documents selected `content { body }`, which is invalid, so the
  "retry with the other shape" fallback in `project()`/`initiative()` could
  only ever turn one error into two. The scalar form is the only valid one;
  the fallback, its two documents, and the two shape caches are gone.
- **`issueLabels(filter: { team: { id: { eq: $teamId } } })` needs `ID`, not
  `String`.** `LABELS_QUERY` declared `$teamId: String` and would have been
  rejected - it was also unreachable, since `labels()` pages the workspace
  query and filters in memory. Deleted rather than fixed.
- **An API-created issue lands in the team's default state, which is `Triage`
  on a triage-enabled team, unless `stateId` is passed.** Observed: 8 planned
  issues created with no `stateId` all arrived in Triage - the shared inbox
  `foreman plan`'s `triage` rule consumes (§7.1) - so agent-authored, already-classified work
  re-entered intake as if a human had filed it. Every extension-created issue
  (plan's `proposedIssues`, refine's `subIssues` and spike, implement's
  `discoveredWork`) now names Backlog explicitly. The spike was also created
  with no `type:` label at all, which §13.1 requires on every issue leaving
  Triage.
- **`resolveState` maps all eight Foreman states against a real workspace.**
  Measured on team PLT (9 states): Triage, Backlog, Todo, In Progress, In
  Review, Done, Canceled, Duplicate all resolve by name, so none of the
  category fallbacks are load-bearing there.

## Verified writing project relations

Introspected against the live API while building project-dependency
scheduling (SPEC §4.10a), the same way the issue-relation facts above were
checked, not assumed from documentation.

- **`ProjectRelation` has no `direction` field on the wire, and there is no
  `ProjectRelationType` enum.** `type`, `anchorType`, and `relatedAnchorType`
  are all plain `String` in `ProjectRelationCreateInput`. Orientation instead
  comes from which connection a row was read through — `Project.relations`
  for outgoing, `Project.inverseRelations` for incoming — the client
  reconstructs `direction` from the query shape, the same trick `IssueRelation`
  does not need because it carries a real `direction` field.
- **A live workspace write uses `type: "dependency"`, `anchorType: "end"`,
  `relatedAnchorType: "start"`.** That is the source project's finish gating
  the target project's start; read from the target, the edge is "blocked by"
  (§4.10a).
- **`ProjectRelationCreateInput` requires both anchor fields alongside
  `projectId`, `relatedProjectId`, and `type`** — there is no default anchor
  pair, so a caller that omits either one is rejected rather than getting an
  implicit `end`/`start`.
- **`Project.startDate`/`targetDate` are `TimelessDate`, not `DateTime`, and
  the API rejects a full timestamp.** Every write is a plain `YYYY-MM-DD`
  string; `foreman-roadmap`'s `RoadmapResult` schema enforces the pattern
  itself rather than discovering the rejection at mutation time (§7.7).
- **Nesting both relation connections under `initiative.projects(first:
  250)` is rejected outright — `Query too complex`.** Fetching `relations`
  and `inverseRelations` on every project inside one initiative-scoped page
  exceeds Linear's query-complexity ceiling. Project relations are instead
  fetched per project, one call per candidate, never nested under the
  initiative's project connection.

## Verified terminal-status filtering

Introspected against the live API while building the terminal-state exclusion
(§4.2a). Both facts below are what let the filter live server-side instead of
as an extra per-issue status read.

- **`IssueFilter.project` is a `NullableProjectFilter`, carrying both a real
  `null` field and a real `status: ProjectStatusFilter`.** A single `project`
  clause can therefore say "no project" or "project's status is such-and-such"
  in the same filter object, which is what lets `notInTerminalProject()`
  express "no project, or a project whose status isn't terminal" as one `or`
  without a second query — and it preserves the `null` branch deliberately,
  so a project-less issue still surfaces through the filter as `no-project`
  out-of-scope (§9) instead of silently vanishing from every saved view.
- **`ProjectStatusFilter.type` and `WorkflowStateFilter.type` are both
  `StringComparator`, so both support `nin`.** Excluding terminal issues and
  terminal-project issues costs a narrower result set at query time, not an
  extra status lookup per row.

## Verified the product Context doc resolves through the team

Introspected and executed against the live API while re-homing §4.7's product
`Context` doc off the initiative layer. Foreman attaches nothing to an
initiative — `results/apply.ts` has no `initiativeToProjectCreate`,
`provision.ts` has no per-initiative pass, and `config/load.ts` rejects a
`repos.<alias>.initiatives` key — so the product layer had to come from
somewhere that always exists. It comes from the team. An initiative is now
read only as §4.7's optional extra layer, for a project that happens to
belong to exactly one.

- **`Document` carries a `team` field and `DocumentFilter` has a `team`
  input, but `Team` has no `documents` field.** A team-scoped document is a
  real, filterable surface, but the filter has to be applied at the root
  `documents(filter: { team: { key: { eq } } })` query rather than through
  `Team.documents`, because that field does not exist.
- **`IssueFilter.id` is an `IssueIDComparator`** — "Comparator for issue
  identifiers" — so it accepts human identifiers, not only UUIDs.
  `{ id: { in: ["PLT-183", "PLT-135"] } }` executed and returned exactly
  those two issues, resolving a whole triage dispatch batch in one hop.
- **`IssueConnection` exposes only `edges`, `nodes`, `pageInfo` — no
  `totalCount`.** A project's issue count cannot be read cheaply; "has any
  issue" is one `first: 1` probe, which is why `/foreman:plan`'s gate is a
  boolean rather than a count comparison.
- **`Project.initiatives` and `initiative(id) { documents }` both validate
  and execute, and this workspace has zero initiatives.** `bun run
  schema:linear` validates 36 documents including both, and a live sweep of
  all 12 `PLT` projects returned `0/12` with any initiative membership; a
  root `initiatives(first: 10)` query returned an empty node list. So §4.7's
  optional layer is exercised against real API shapes, but its populated
  path cannot be smoke-tested until an operator creates an initiative by
  hand — which is the point: it is optional, and the ordinary case is a
  digest byte-identical to the two-layer output.
- **`DocumentCreateInput` requires only `title`, and accepts `teamId` +
  `content`.** Seeding the team's `Context` doc is one mutation, which is why
  `provisionTeam` folds it into its existing single confirm rather than
  needing a scope of its own.
- **Linear rewrites the emphasis marker it is given: a document created with
  `_text_` reads back as `*text*`.** Measured by seeding
  `CONTEXT_DOC_TEMPLATE` on PLT and reading it straight back — 566 stored
  bytes against 567 sent, with every `_..._` placeholder returned as
  `*...*` and the trailing newline dropped. Any check that compares stored
  document content against the template it wrote MUST normalise emphasis
  first; matching raw substrings reported a doc seconds old as filled in.
- **Linear also rewrites list bullets: a line written as `- item` reads back
  as `* item`, while a `- [ ]` task item keeps its dash.** Measured by a live
  round trip of `applyContextResult` on FMN — the appended `- Smoke probe…`
  line came back as `* Smoke probe…`, and the seeded Definition of Done's
  `- [ ] Tests written and passing` did not change. This is why
  `comparableLine` in `domain/context-doc.ts` normalises the leading list
  marker as well as emphasis: normalising emphasis alone mapped a `*` bullet
  to `_` while leaving a `-` bullet untouched, so a proposal that faithfully
  re-sent the line it had just read was refused as an undeclared removal.
  Reasoning did not find this; only the round trip did.
