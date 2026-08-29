/**
 * Shared by `main.ts` (`foreman loop`) and `intake.ts` (`foreman intake`):
 * both report this string in `status.json` and their control-plane
 * handshake. Hardcoded rather than imported from `package.json` — reading it
 * at runtime means resolving a path relative to the compiled output, which
 * differs between `bun run` and the packaged CLI. One shared constant means
 * only one place to bump on release, instead of two hand-synced copies.
 */
export const LOOP_VERSION = "0.1.0";
