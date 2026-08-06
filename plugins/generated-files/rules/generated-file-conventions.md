---
description: This file's name marks it as generator output — a hand edit survives only until the next build, and lies to every reader until then
condition:
  - "**/*.generated.*"
  - "**/generated/**"
  - "**/__generated__/**"
  - "**/*.gen.*"
  - "**/*.g.dart"
  - "**/*_generated.go"
interruptMode: tool-only
---

That path is **generator output**, not source: `.generated.`, `.gen.`,
`.g.dart`, `_generated.go`, and anything under `generated/` or
`__generated__/` are rewritten wholesale by a build step.

- **Edit what produced it** — the schema, the token table, the template, or
  the codegen config — then re-run the generator.
- **Find the generator by searching for this output's own filename.** Grep the
  repo for it in codegen configs, build scripts, task-runner definitions, and
  the package manifest's scripts. Whatever declares the file as an *output*
  owns it, and the same entry names the input it reads.
- **Run the generator the way the pipeline does**, from the committed command,
  so the result matches byte-for-byte what CI produces.
- **A checked-in generated file is a cache**, and CI commonly verifies it with
  a regenerate-and-diff step — a hand edit is a red build, not a shortcut.
- **A hand edit is invisible after the next build** and, until then, tells
  every reader the file agrees with its source when it does not.

If the generator can't express what you need, the change belongs in the
generator, its template, or its options. If the file is not actually
generated despite the name, that is a naming bug — rename it in this change.
