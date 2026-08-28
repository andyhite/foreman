/**
 * Shared command-name registry, so a single edit switches the naming
 * convention if `pi.registerCommand` rejects a colon (SPEC §3.4).
 *
 * We shipped the colon form (`foreman:status`, etc.) — `pi.registerCommand`
 * accepted it in testing. `FALLBACK_NAMES` is kept ready and unused as the
 * one-line switch if a future omp version rejects the colon.
 */

export const COMMAND_NAMES = {
  status: "foreman:status",
  apply: "foreman:apply",
  merge: "foreman:merge",
  unblock: "foreman:unblock",
} as const;

export const FALLBACK_COMMAND_NAMES = {
  status: "foreman-status",
  apply: "foreman-apply",
  merge: "foreman-merge",
  unblock: "foreman-unblock",
} as const;

export type CommandKey = keyof typeof COMMAND_NAMES;
