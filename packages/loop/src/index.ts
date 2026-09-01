/**
 * `@foreman/loop` entrypoint: the two loop-package CLIs (SPEC §3.1) —
 * `foreman repo` (per-repo supervisor, §3.11) and `foreman team`
 * (team-level triage process, §3.12). One export surface so `packages/cli`
 * never reaches past this file into `src/repo.ts` or `src/team.ts` directly.
 */

export { runRepo } from "./repo.ts";
export { runTeam } from "./team.ts";
