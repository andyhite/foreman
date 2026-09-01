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

**The manifest lives at `.omp-plugin/plugin.json`.** §3.1 says
`.claude-plugin/plugin.json`; that is the Claude Code fallback. The omp-native
location is `.omp-plugin/`.

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
