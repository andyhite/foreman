/**
 * Entry predicates for a `foreman-refine` dispatch (SPEC §10).
 *
 * Pure: everything needed is already on the fetched `Issue`. No Linear calls
 * here — a gate that fetches is a gate that can be evaluated inconsistently
 * across the callers that share it (agents, commands, hooks).
 */

import { isTerminal } from "../domain/states.ts";
import { PRIORITY } from "../domain/priority.ts";
import type { Issue } from "../linear/types.ts";
import type { GateFailure, GateResult } from "./types.ts";

/**
 * Entry predicate for a `foreman-refine` dispatch (SPEC §10). The exit
 * predicate is `refinementGate` — acceptance criteria and an estimate are
 * what refine *produces*, so requiring them here refuses every real
 * candidate. Only the two refusals the agent and command prose actually
 * claim belong in front of a refine dispatch.
 */
export function refineEntryGate(issue: Issue): GateResult {
  const failures: GateFailure[] = [];
  if (isTerminal(issue.state)) {
    failures.push({
      code: "terminal-state",
      message: `Issue is ${issue.state.name} (${issue.state.type}); finished work is never refined or implemented.`,
    });
  }
  if (issue.priority === PRIORITY.None) {
    failures.push({ code: "priority-none", message: "Priority is unset (`None`)." });
  }
  return { ok: failures.length === 0, failures };
}
