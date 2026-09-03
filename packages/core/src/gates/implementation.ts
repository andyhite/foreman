/**
 * Implementation gate (`Ready → In Progress`, SPEC §10).
 *
 * Folds the refinement gate's failures in rather than re-deriving them:
 * a `legacy` issue sitting in Ready has never passed refinement, so it must
 * still fail here (SPEC §4.9) — there is no separate legacy code path.
 */

import { incompleteBlockers, isHandsOff } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import { typeLabel } from "../domain/labels.ts";
import { FOREMAN_STATE } from "../domain/states.ts";
import { refinementGate } from "./refinement.ts";
import type { GateFailure, GateResult } from "./types.ts";

export function implementationGate(issue: Issue, viewerId: string): GateResult {
  const failures: GateFailure[] = [...refinementGate(issue).failures];

  if (issue.state.name.trim().toLowerCase() !== FOREMAN_STATE.ready.toLowerCase()) {
    failures.push({
      code: "wrong-state",
      message: `Issue is ${issue.state.name}; implement only picks up ${FOREMAN_STATE.ready}.`,
    });
  }

  if (isHandsOff(issue, viewerId)) {
    failures.push({
      code: "hands-off",
      message: `Issue is assigned to ${issue.assignee?.displayName ?? issue.assignee?.name}; agents leave an operator-assigned issue alone.`,
    });
  }

  if (typeLabel(issue) === null) {
    failures.push({
      code: "missing-type-label",
      message: "Issue has no `type:` label.",
    });
  }

  const blockers = incompleteBlockers(issue);
  if (blockers.length > 0) {
    failures.push({
      code: "incomplete-blockers",
      message: `${blockers.length} incomplete blocker(s): ${blockers
        .map((relation) => relation.other.identifier)
        .join(", ")}.`,
    });
  }

  return { ok: failures.length === 0, failures };
}
