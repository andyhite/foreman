---
description: Silencing clippy on the command line hides the finding from review — an inline `#[allow]` carrying a reason does not
condition: '--cap-lints[=\s]*allow|(?:-A|--allow)[=\s]*clippy::(?:all|pedantic|nursery|cargo|correctness|complexity|perf|style|suspicious)\b|\b(?:cargo\s+(?:clippy|build)|RUSTFLAGS=)[^\n]*["''\s](?:-A|--allow)[=\s]*warnings\b'
scope: "tool:bash"
interruptMode: tool-only
---

That flag turns lints off for an entire compilation:

- Clippy is the cheapest correctness signal Rust offers — most of its default
  lints name a real bug class, not a style preference. Turning the group off
  discards the findings you have not looked at yet along with the one you have.
- **A command-line `-A` leaves no trace in the tree.** The next reader sees
  clean output and no record that anything was suppressed, so the finding never
  reaches review.
- **`#[allow(lint)]` at the narrowest scope, with a comment giving the reason**,
  is the reviewable form: it shows up in the diff, it expires with the code it
  annotates, and it says who decided.
- **A project-wide decision belongs in the manifest**, not in your shell
  history — `[lints.clippy]` in `Cargo.toml` or a `clippy.toml`, in a commit
  that explains it.
- **`--cap-lints allow` is legitimate for vendored third-party code you do not
  maintain** — that is exactly what cargo does for registry dependencies.
  Pointed at your own crates it mutes the code you are responsible for.

A lint you had to switch off to get green is a finding, not noise. Fix it, or
record the exemption where the next reader will trip over it.
