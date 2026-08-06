---
description: An API spec and its client generate in one direction only — edit the end that is output and your change is silently reverted at the next build
condition:
  - "**/openapi.json"
  - "**/openapi.yaml"
  - "**/swagger.json"
  - "**/*.api.generated.ts"
interruptMode: tool-only
---

An API description is either hand-written source or emitted output, and a repo
picks exactly one direction. **Determine which before editing either end:**

- **Spec-first**: the spec document is source, reviewed like code, and the
  client (often server stubs too) is generated from it. Edit the spec,
  regenerate, and never patch the client.
- **Code-first**: the server's handler types, annotations, or decorators are
  source, and the spec is exported from them by a build step or a dedicated
  command. Edit the handlers and re-export; an edit to the spec is reverted
  the next time it is produced.
- **The tell is a generator config that lists the file as an output** — a
  codegen input/output pair, a client-generator invocation, an export script.
  Whichever end is an *input* is source; the end that is an *output* is not.
- **A `*.api.generated.ts` client is always the downstream end**, in either
  direction. Wrap it in hand-written code; don't patch it.
- **A silently reverted edit is worse than a rejected one** — it passes
  review, ships, and disappears at the next regeneration.

If both ends look hand-maintained, the repo has drifted: pick the direction,
write it down, and make the build regenerate-and-diff it.
