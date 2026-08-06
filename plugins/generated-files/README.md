# generated-files

Four path interrupt rules for files a machine wrote. They fire on the
`write`/`edit` of an artifact some generator owns, so the change lands in the
source instead of in the output. Nothing here assumes a language, a build
tool, or any particular workflow — install it in any repo.

| Rule | Fires on | Point |
|---|---|---|
| `generated-file-conventions` | `*.generated.*`, `generated/`, `__generated__/`, `*.gen.*`, `*.g.dart`, `*_generated.go` | The name says output. Edit the schema, template, or codegen config and re-run; find the generator by grepping for the output's own filename. |
| `generated-protocol-code` | `*.pb.go`, `*_pb2.py`, `*_pb2_grpc.py`, `*.pb.cc`, `*.pb.h`, `*_pb.js`, `*_pb.d.ts`, `*.pbobjc.*` | Stubs come from an IDL. Out of sync with its schema, a stub is a wire-format bug — the peer still generates from the schema. |
| `generated-orm-and-migrations` | `schema.graphql`, `graphql.schema.json`, `prisma/migrations/`, `drizzle/meta/`, `*.sqlc.go` | An applied migration is history; the fix is always a new migration. One you just generated and haven't applied or committed gets regenerated, not edited. |
| `generated-api-clients` | `openapi.json`, `openapi.yaml`, `swagger.json`, `*.api.generated.ts` | Spec-first or code-first decides which end is source. Edit the generated end and the next build silently reverts you. |

All four are path rules with `interruptMode: tool-only`: the condition is a
glob sequence, so they match the file actually being written or edited — never
prose or a code block that merely mentions one of these paths.

## Lockfiles are deliberately out of scope

Package-manager lockfiles are generated too, and this pack ships no glob for
any of them. They belong to the per-tool packs in the same marketplace —
`pnpm`, `npm`, `yarn`, `bun`, `uv`,
`pip`, and `cargo` — each of which covers its own lockfile
with advice specific to that tool's install, resolution, and CI flags.
Duplicating those globs here would double-fire for anyone running both.

## Install

```sh
omp plugin marketplace add andyhite/omp-foreman
omp plugin install generated-files@omp-foreman
```

Independent of every other plugin in this marketplace — install it on its own
or alongside them.
