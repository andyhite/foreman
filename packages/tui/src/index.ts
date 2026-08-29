/**
 * `@foreman/tui` — the command center reached as `foreman tui` (SPEC §17, §3.11, §3.12).
 *
 * A single barrel export, same shape as `@foreman/loop`: the CLI needs only
 * `runTui`, everything else here (store, views, session) is this package's
 * own internal wiring.
 */

export { runTui } from "./main.ts";
