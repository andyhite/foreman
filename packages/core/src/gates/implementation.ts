/**
 * Implementation gate (`Todo → In Progress`, SPEC §10).
 *
 * Folds the refinement gate's failures in rather than re-deriving them:
 * a `legacy` issue sitting in Todo has never passed refinement, so it must
 * still fail here (SPEC §4.9) — there is no separate legacy code path.
 */

import { incompleteBlockers } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import { foremanLabel } from "../domain/labels.ts";
import { refinementGate } from "./refinement.ts";
import type { GateFailure, GateResult } from "./types.ts";

export function implementationGate(issue: Issue): GateResult {
  const failures: GateFailure[] = [...refinementGate(issue).failures];

  if (issue.state.type !== "unstarted") {
    failures.push({
      code: "not-in-todo",
      message: `Issue is ${issue.state.name} (${issue.state.type}); implementation requires Todo.`,
    });
  }

  const held = foremanLabel(issue);
  if (held !== null) {
    failures.push({
      code: "foreman-label",
      message: `Carries \`${held}\`.`,
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
