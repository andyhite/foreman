---
description: These stubs are compiled from an IDL schema — a stub edited out of sync with its schema is a wire-format bug, because the other side of the connection still uses the schema
condition:
  - "**/*.pb.go"
  - "**/*_pb2.py"
  - "**/*_pb2_grpc.py"
  - "**/*.pb.cc"
  - "**/*.pb.h"
  - "**/*_pb.js"
  - "**/*_pb.d.ts"
  - "**/*.pbobjc.*"
interruptMode: tool-only
---

That file is **protocol stub code**, emitted from a `.proto` or other IDL by
protoc, buf, or an equivalent plugin chain.

- **Edit the schema, then regenerate** with the repo's committed generation
  command and its pinned plugin versions — a hand-tuned stub drifts from
  every other language's stubs the moment anyone regenerates.
- **The schema is the contract; this file is one language's view of it.** The
  peer on the other end generated its own stubs from the same schema, so a
  change only here is a wire-format disagreement between two processes.
- **Field numbers and wire types are the compatibility surface.** Renumbering
  or retyping an existing field breaks already-deployed peers; add new fields
  with new numbers and reserve the numbers you remove.
- **Generation options are the supported knob** — plugin selection, package
  and import-path overrides, output layout. They are versioned, and they
  apply to every language at once.
- **Add behavior beside the stub, not inside it**: a hand-written file that
  wraps or extends the generated type survives regeneration.

Committed stubs are usually regenerated and diffed in CI, so an edit here
fails the build; gitignored ones vanish on the next clean checkout.
