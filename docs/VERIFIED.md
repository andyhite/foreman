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
| 3 | Slash-command namespacing | **`/foreman:<name>`** | Plugin commands are named `<plugin>:<file-stem>` automatically and it cannot be overridden. The spec's `/foreman-triage` spelling is wrong; `commands/triage.md` becomes `/foreman:triage`. Extension-registered commands are not namespaced by the runtime, so they carry the prefix explicitly. |
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
location is `.omp-plugin/`. (§3.1 has since been corrected.)

**A gitignored `dist/` ships a plugin whose extension never loads.** `omp
plugin install <name>@<marketplace>` copies the plugin directory out of a git
clone of the marketplace repo and symlinks it into the scope's `node_modules`;
it never runs a package manager and never builds. `package.json` pointed
`omp.extensions` at `./dist/extension.js` while `.gitignore` excluded `dist/`,
so every repo that installed Foreman the normal way got a plugin with no
extension entrypoint at all — and omp includes a declared entry only if the
file exists, dropping a missing one without a warning. The failure is
especially convincing because `agents/`, `commands/`, `skills/`, and `rules/`
are auto-discovered straight from the copied tree: `/foreman:plan` expanded its
prompt exactly as designed while both tools, the task guard, the lock manager,
the result appliers, and all four `pi.registerCommand` commands were absent.
Confirmed by A/B: in a repo whose install lacked the bundle the agent reported
no `foreman_linear_read` in any form, and the same repo loaded and called it
top-level once given a copied tree that carried `dist/extension.js`.
So the bundle is committed, and CI plus `check-contract.ts` guard it.

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

**None of that is why the bundle exists.** The bundle exists because a
marketplace install runs no package manager — the installed copy has no
`node_modules` at all — and the plugin's only dependency, `@foreman/core`, is
`private: true` and `workspace:*`. Bundling resolves the root TypeBox specifier
at build time as a side effect, which is why the shim never fires in
production. Adopting omptype in core instead is not an option: `packages/cli`
ships the standalone `foreman` binary, depends on core, and has no omp
dependency, and `foreman init` is what installs the omp plugin — so core would
need omp's internals to read `~/.foreman/config.json` before omp is present.

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

**There is no `foreman-loop` binary.** §17 names one, in eight places, and it
was written before the spec had a `foreman` CLI at all — §18 puts the supervisor
at build step 6 and the installer nowhere. Two installed binaries whose names
differ by a hyphen is not a surface an operator can hold, so the supervisor is
the `repo` subcommand of `foreman`, which owns every argument after it. The
team-level triage process is likewise the `team` subcommand. The log prefix
and the herdr pane label (§17.3, §17.5) track those names — `foreman-repo` and
`foreman-team` — naming the long-lived process, not the command, which is
exactly what §17 describes.

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
  The supervisor session that runs `/foreman:*` is exactly that shape, so both
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

## Verified building the control plane

- **macOS caps a unix socket path at 104 bytes.** A `stateDir` nested a few
  levels deep (a long home directory, a long repo alias) can push
  `<stateDir>/<loop>/control.sock` past that limit, and `bind()` fails outright
  rather than truncating. `loopPaths` checks the length up front and falls back
  to a hashed path under `os.tmpdir()` when the natural path would exceed it.
- **TypeScript does not keep a narrowing on a class field or object property
  across an `await`, including through get/set accessors.** A run-state check
  before an `await` and another one after it compare as two unrelated literal
  types, and the second comparison is flagged dead code even though the field
  can genuinely have changed underneath the `await`. Both `Supervisor` and
  `IntakeRuntime` read their run state through a method call
  (`currentRunState()`) instead of a field or accessor read, because a method
  call is a boundary the narrower won't cross — it has no way to know the
  method returns a stored value rather than computing one. An accessor pair
  (`get`/`set`) was tried first and does not fix it; the narrowing still
  collapses across the `await`.
- **`Omit<T, K>` does not distribute over a union.** `Omit<ControlEvent, "seq"
  | "at">`, where `ControlEvent` is a discriminated union whose members carry
  different extra fields (`runtime`, `line`, `agent`, ...), collapses to the
  intersection of keys every member shares and then rejects any of those
  member-specific fields. The protocol instead exports a distributive
  `EmittableEvent` type — an `Omit` applied inside a conditional type that
  distributes over the union — so each member keeps its own fields minus
  `seq`/`at`.
- **A listening unix socket keeps Bun's event loop alive**, so setting
  `process.exitCode` on a fatal startup path is not enough to make the process
  exit — an open server handle is still a live event-loop reference. This was
  observed as a real zombie: a loop that failed during the ensure pass (a 401
  from a stale Linear key) kept running because its control server was still
  listening, holding `loop.lock` (§11) and making every subsequent `foreman
  loop` fail with `LoopLockHeldError` until the process was killed by hand.
  `runLoop` and `runIntake` now wrap everything after lock acquisition in one
  `try/finally` that stops the supervisor and closes the control server, so a
  fatal error always releases both.
- **`/foreman:status` read `<stateDir>/loop-state.json`, which no code ever
  wrote.** Nothing had produced that file since the command was written; it
  always read as absent. The command now reads the `status.json` the control
  plane publishes (§20.1), which is a file something actually writes.

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
