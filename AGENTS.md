# Foreman

An omp plugin plus loop and CLI that run a single-operator agile SDLC over
Linear. Agents move an issue one state right and return validated structured
output; the extension performs every mutation. Read `README.md` for the
operator view, `docs/SPEC.md` for the design, `docs/VERIFIED.md` for what was
measured against omp and Linear where the spec was wrong.

<critical>
- NEVER hand a `foreman-*` agent `task`, `spawns`, a Linear write tool, `schemaMode`, or `isolated`. The task guard forces strictness at spawn; frontmatter omission is the fan-out control.
- NEVER edit the generated `output:` block in `packages/omp-plugin/agents/*.md`. Edit `packages/core/src/schemas/*.ts`, run `bun run schemas`.
- NEVER add a second Linear write path. `packages/core/src/linear/client.ts` behind the extension is the only one.
- `bun run check` MUST pass before a PR: typecheck + tests + contract.
</critical>

## Layout

| Package | Owns |
| --- | --- |
| `packages/core` | Domain (states, labels, priority), gates, output schemas + parsers, Linear/GitHub/git clients, config schema + loader, lock, markers |
| `packages/loop` | The rule engine and the three loop CLIs — `foreman build`, `foreman plan`, `foreman reconcile` — plus dispatchers (`print`, `herdr`), in-flight tracking, escalation |
| `packages/cli` | `foreman setup` / `init` / `deinit` / `doctor` / `update`, plugin activation, wizard |
| `packages/omp-plugin` | The plugin omp loads: agents, skills, commands, rules, `src/extension.ts`. See its README |
| `docs/` | `SPEC.md` (design, § references throughout the code), `VERIFIED.md` (measured answers) |

## Commands

```bash
bun run typecheck      # tsc --build --force
bun test               # bun test; per package: bun test packages/<name>
bun run contract       # plugin wiring: frontmatter YAML, tools, skills, rules, schema drift
bun run schemas        # regenerate output schemas into agent frontmatter + schemas/*.json
bun run check          # all three
bun run setup          # foreman setup --link from source
```

## Conventions

- TypeScript, ESM, Bun ≥1.3. No build for the plugin; the CLI builds to `packages/cli/dist`.
- Comments explain a non-obvious *why*, often with a `SPEC §` or `VERIFIED.md` pointer. A line that looks redundant usually prevents a measured failure: check `git blame` before deleting.
- Tests: `bun test`, colocated under `packages/<name>/test/`. Test observable behavior against fakes of the Linear/GitHub clients; never call the network.
- Prompt files (agents, skills, commands, rules) follow house style: RFC 2119 keywords in caps, `<critical>` first, procedure numbered, one claim per bullet. Skill `description` fields are retrieval surface; keep them natural.
- Marker lines (`FOREMAN-ISSUE`, `FOREMAN-DISPATCH`, …) in task text are the contract between `commands/*.md`, `src/enforce/task-guard.ts` (writer), and `src/results/sink.ts` (reader) in the plugin. Change all of them together.

## Verifying a change

- Plugin markdown: `bun run contract`, then `/reload-plugins` in an omp session inside a registered repo.
- `src/extension.ts` or imports: restart the omp session.
- Loop or CLI: `bun test packages/<name>` plus `foreman build <alias> --once` (or `foreman plan <alias> --once`) in `confirm` mode (decline everything) for a dry run.
