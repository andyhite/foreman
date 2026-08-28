/**
 * Gates are machine-checkable predicates, never prose (SPEC §10, principle 4).
 *
 * One implementation, consumed by agents, commands, the loop's workers, and the
 * extension's `task` interceptor alike. A gate reimplemented in a skill body is
 * a gate that will disagree with this one.
 */

export interface GateFailure {
  /** Stable machine code, e.g. `missing-type-label`. Safe to switch on. */
  code: string;
  /** One line the operator can act on. */
  message: string;
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
}

/** Name of each gate, for logging and for the interceptor's error messages. */
export type GateName = "refinement" | "implementation" | "review";

export function gateSummary(name: GateName, result: GateResult): string {
  if (result.ok) return `${name} gate: pass`;
  return `${name} gate: fail — ${result.failures.map((f) => f.message).join("; ")}`;
}
