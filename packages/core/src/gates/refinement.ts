/**
 * Refinement gate (`Backlog → Todo`, SPEC §10).
 *
 * Pure: everything it needs is already on the fetched `Issue`. No Linear
 * calls here — a gate that fetches is a gate that can be evaluated
 * inconsistently across the callers that share it (agents, commands, hooks).
 */

import { hasAcceptanceCriteria } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import { isTerminal } from "../domain/states.ts";
import { PRIORITY } from "../domain/priority.ts";
import type { GateFailure, GateResult } from "./types.ts";

/** SPEC §4.6: 5 means "split it", so refinement caps the estimate at 3. */
const MAX_REFINED_ESTIMATE = 3;

export function refinementGate(issue: Issue): GateResult {
  const failures: GateFailure[] = [];

  // Checked before anything else because it is the one failure no amount of
  // refinement can fix: the work is over. The loop's own queries already
  // exclude terminal issues (SPEC §4.2a), so this is what catches the
  // operator-invoked path — `/foreman:refine ENG-1` on an issue somebody
  // canceled while it sat in the Backlog.
  if (isTerminal(issue.state)) {
    failures.push({
      code: "terminal-state",
      message: `Issue is ${issue.state.name} (${issue.state.type}); finished work is never refined or implemented.`,
    });
  }

  if (issue.priority === PRIORITY.None) {
    failures.push({
      code: "priority-none",
      message: "Priority is unset (`None`).",
    });
  }

  if (!hasAcceptanceCriteria(issue.description)) {
    failures.push({
      code: "missing-acceptance-criteria",
      message: "Description has no `## Acceptance Criteria` section with at least one item.",
    });
  }

  if (issue.estimate === null) {
    failures.push({
      code: "missing-estimate",
      message: "Estimate is unset.",
    });
  } else if (issue.estimate > MAX_REFINED_ESTIMATE) {
    failures.push({
      code: "estimate-too-large",
      message: `Estimate ${issue.estimate} exceeds ${MAX_REFINED_ESTIMATE}; split the issue (SPEC §4.6).`,
    });
  }

  return { ok: failures.length === 0, failures };
}
