/**
 * Refinement gate (`Backlog → Todo`, SPEC §10).
 *
 * Pure: everything it needs is already on the fetched `Issue`. No Linear
 * calls here — a gate that fetches is a gate that can be evaluated
 * inconsistently across the callers that share it (agents, commands, hooks).
 */

import { hasAcceptanceCriteria } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import { blockedLabel, typeLabel } from "../domain/labels.ts";
import { PRIORITY } from "../domain/priority.ts";
import type { GateFailure, GateResult } from "./types.ts";

/** SPEC §4.6: 5 means "split it", so refinement caps the estimate at 3. */
const MAX_REFINED_ESTIMATE = 3;

export function refinementGate(
  issue: Issue,
  membership?: { initiativeCount: number },
): GateResult {
  const failures: GateFailure[] = [];

  if (issue.project === null) {
    failures.push({
      code: "missing-project",
      message: "Issue has no project.",
    });
  }

  if (membership !== undefined) {
    if (membership.initiativeCount === 0) {
      failures.push({
        code: "missing-initiative",
        message: "Project belongs to no initiative (SPEC §4.0).",
      });
    } else if (membership.initiativeCount > 1) {
      failures.push({
        code: "ambiguous-initiative",
        message: `Project belongs to ${membership.initiativeCount} initiatives; exactly one is required (SPEC §4.0).`,
      });
    }
  }

  if (typeLabel(issue) === null) {
    failures.push({
      code: "missing-type-label",
      message: "No `type:` label.",
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

  const blocked = blockedLabel(issue);
  if (blocked !== null) {
    failures.push({
      code: "blocked-label-present",
      message: `Has \`${blocked}\` label.`,
    });
  }

  return { ok: failures.length === 0, failures };
}
