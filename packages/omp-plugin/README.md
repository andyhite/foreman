# foreman

The omp plugin that runs a single-operator agile SDLC over Linear: triage
the inbox, plan bare projects, refine prioritized issues, implement them in
worktrees, review the diff. Agents return validated structured output; the
extension performs every mutation.

## Layout

| Path | Loaded as | Owns |
| --- | --- | --- |
| `agents/*.md` | omp agents | One workflow edge each; frontmatter carries the tool allowlist and the inlined output schema |
| `skills/*/SKILL.md` | autoloaded skills | The procedure each agent follows; supporting files sit beside `SKILL.md` |
| `commands/*.md` | `/foreman:<stem>` | Operator dispatch: resolve, gate, one `task` call |
| `rules/*.md` | TTSR rules | Mid-stream interrupts: no Linear API from a shell, no in-session questions, no scope creep |
| `src/extension.ts` | extension module | Linear write client, gate validators, task guard, lock manager, result sink, config loader, and `/foreman:status`, `/foreman:apply`, `/foreman:merge`, `/foreman:unblock` |
| `schemas/*.json` | reference | Generated copies of each agent's output schema |

Active **per repo only**: `foreman init` writes the repo's omp plugin root
(`.omp/plugins/node_modules/@foreman/omp-plugin` → `~/.foreman/plugin` →
this directory) plus the enable lock. Nothing is copied, so every
registered repo follows the checkout the global symlink points at. See the
repo root README for `foreman setup` / `foreman init`.

No build step: `omp.extensions` names `./src/extension.ts` and omp loads the
TypeScript directly.

## Editing

- Markdown (agents, skills, commands, rules): `/reload-plugins` picks up
  changes without a restart.
- `src/extension.ts` and its imports: restart the omp session.
- Output schemas: edit `packages/core/src/schemas/*.ts`, then `bun run
  schemas`. Never edit the generated block in an agent's frontmatter; omp
  `JSON.parse`s that string, so the schema must stay inlined.
- `bun run contract` after any change here. It parses every frontmatter with
  a real YAML parser, checks tool allowlists, `autoloadSkills` resolution
  and shadowing, rule scopes and regexes, and schema drift.

## Invariants the files encode

- Agent frontmatter never sets `spawns`, `task`, `schemaMode`, or
  `isolated`. Omitting `spawns` and `task` is what prevents fan-out; the
  task guard forces `schemaMode: "strict"` and strips `isolated` at spawn.
- Every agent is `blocking: true`. A background spawn's result arrives
  without structured output, so the extension would have nothing to apply.
- No agent holds a Linear write tool. `foreman_github_pr` on
  `foreman-implement` is the one mutation tool any agent gets.
- Task text carries marker lines (`FOREMAN-ISSUE`, `FOREMAN-PROJECT`,
  `FOREMAN-INITIATIVE`; the guard appends `FOREMAN-DISPATCH`,
  `FOREMAN-WORKTREE`, `FOREMAN-BRANCH`, `FOREMAN-BASE`, `FOREMAN-DIFF`). The
  result sink keys every capture on them.

## Configuration

One global file, `~/.foreman/config.json`: the `repos` registry (alias →
path, team, bound initiatives), loop tuning, and `repoDefaults`, deep-merged
with each entry's overrides.

## Commands

| Command | Dispatches | Argument |
| --- | --- | --- |
| `/foreman:triage` | `foreman-triage`, one batch | `[--stale-low-days <days>] <ISSUE-ID>...` |
| `/foreman:roadmap` | `foreman-roadmap` per initiative | `<INITIATIVE-ID>...` |
| `/foreman:plan` | `foreman-plan` per bare project | `<PROJECT-ID>...` |
| `/foreman:refine` | `foreman-refine` per issue | `<ISSUE-ID>...` |
| `/foreman:implement` | `foreman-implement`, one issue | `<ISSUE-ID>` |
| `/foreman:review` | `foreman-review` per target | `<ISSUE-ID or PR>...` |
| `/foreman:apply` | extension: review or apply staged proposals | none, `--yes`, `<ISSUE-ID> --approve`, `<ISSUE-ID> --reject <reason>` |
| `/foreman:merge` | extension: merge once the review gate passes | `<ISSUE-ID>` |
| `/foreman:unblock` | extension: record the operator's reply, clear the block | `<ISSUE-ID> <reply>` |
| `/foreman:status` | extension: operator console | none |
