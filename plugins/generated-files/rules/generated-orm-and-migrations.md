---
description: An applied migration is history and these schema artifacts are output — editing either makes the migration log disagree with every database that already ran it
condition:
  - "**/schema.graphql"
  - "**/graphql.schema.json"
  - "**/prisma/migrations/**"
  - "**/drizzle/meta/**"
  - "**/*.sqlc.go"
interruptMode: tool-only
---

That path is schema state a tool maintains, and a migration directory is an
append-only log:

- **An applied migration is immutable history.** Every database that ran it
  recorded it, usually with a checksum; changing the text yields a checksum
  mismatch that halts the migrator, or silent divergence where two databases
  report one version with two schemas.
- **The fix is always a new migration** that moves the schema forward — the
  one that shipped plus the one that corrects it, never a rewritten entry.
- **A migration you just generated, applied nowhere and committed nowhere, is
  different**: drop it and regenerate from the updated model.
- **Migration metadata** — journal, lock, and snapshot files under a tool's
  `meta` directory — is the generator's bookkeeping; editing it desynchronizes
  the log from the database's history table, which re-runs applied migrations.
- **`schema.graphql`, `graphql.schema.json`, and `*.sqlc.go` are exports** —
  from resolvers or an SDL source, from introspection, and from your `.sql`
  queries plus the schema. Edit that input and re-run the generator.

If this repo treats an SDL file as hand-written source rather than an export,
that is the one path here you may edit — check the generator config first.
