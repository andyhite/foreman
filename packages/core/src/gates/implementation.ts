/**
 * Implementation gate (`Todo → In Progress`, SPEC §10).
 *
 * Folds the refinement gate's failures in rather than re-deriving them:
 * a `legacy` issue sitting in Todo has never passed refinement, so it must
 * still fail here (SPEC §4.9) — there is no separate legacy code path.
 */

import { incompleteBlockers } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import { AGENT_LABEL, hasLabel } from "../domain/labels.ts";
import { refinementGate } from "./refinement.ts";
import type { GateFailure, GateResult } from "./types.ts";

export function implementationGate(
  issue: Issue,
  membership?: { initiativeCount: number },
): GateResult {
  const failures: GateFailure[] = [...refinementGate(issue, membership).failures];

  if (!hasLabel(issue, AGENT_LABEL.ready)) {
    failures.push({
      code: "missing-agent-ready",
      message: `Missing \`${AGENT_LABEL.ready}\` label.`,
    });
  }

  if (hasLabel(issue, AGENT_LABEL.running)) {
    failures.push({
      code: "agent-running",
      message: `Has \`${AGENT_LABEL.running}\` label — already dispatched.`,
    });
  }

  if (hasLabel(issue, AGENT_LABEL.handsOff)) {
    failures.push({
      code: "agent-hands-off",
      message: `Has \`${AGENT_LABEL.handsOff}\` label.`,
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
