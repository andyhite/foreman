/**
 * `@foreman/loop` entrypoint: the two loop-package CLIs (SPEC §3.1) —
 * `foreman loop` (per-repo supervisor, §3.11) and `foreman intake`
 * (team-level triage process, §3.12). One export surface so `packages/cli`
 * never reaches past this file into `src/main.ts` or `src/intake.ts` directly.
 */

export { runLoop } from "./main.ts";
export { runIntake } from "./intake.ts";
