/**
 * Review gate (`In Review → Done`, SPEC §10).
 *
 * `ReviewResult` is pinned to the SHA it reviewed (SPEC §11 lock comment
 * discipline mirrors this: machine state rides with the thing it describes).
 * A push after review invalidates it even if every check inside it passed.
 */

import { acceptanceCriteria } from "../linear/issue.ts";
import type { Issue } from "../linear/types.ts";
import type { ReviewResult } from "../schemas/review.ts";
import type { GateFailure, GateResult } from "./types.ts";

export interface ReviewGateInput {
  issue: Issue;
  review: ReviewResult | null;
  headSha: string | null;
  ciStatus: "success" | "failure" | "pending" | "none";
  prOpen: boolean;
  prRequired: boolean;
  ciRequired: boolean;
}

export function reviewGate(input: ReviewGateInput): GateResult {
  const { issue, review, headSha, ciStatus, prOpen, prRequired, ciRequired } = input;
  const failures: GateFailure[] = [];

  if (review === null) {
    failures.push({
      code: "missing-review",
      message: "No ReviewResult on record.",
    });
  } else if (headSha === null || review.reviewedSha !== headSha) {
    failures.push({
      code: "stale-review",
      message: `ReviewResult reviewed ${review.reviewedSha}, but head is ${headSha ?? "unknown"}.`,
    });
  }

  if (ciRequired && ciStatus !== "success") {
    failures.push({
      code: "ci-not-green",
      message: `CI status is \`${ciStatus}\`, not \`success\`.`,
    });
  }

  if (review !== null) {
    const blocking = review.findings.filter((finding) => finding.severity === "blocking");
    if (blocking.length > 0) {
      failures.push({
        code: "blocking-findings",
        message: `${blocking.length} outstanding blocking finding(s).`,
      });
    }

    const requiredCriteria = acceptanceCriteria(issue.description);
    const unchecked = review.criteriaVerification.filter((entry) => !entry.satisfied);
    if (unchecked.length > 0 || review.criteriaVerification.length < requiredCriteria.length) {
      failures.push({
        code: "unverified-criteria",
        message: `${unchecked.length} criterion/criteria unchecked or unverified against the issue's list.`,
      });
    }

    if (!review.dodSatisfied) {
      failures.push({
        code: "dod-unsatisfied",
        message: "Definition of Done not satisfied.",
      });
    }
  }

  if (prRequired && !prOpen) {
    failures.push({
      code: "pr-not-open",
      message: "PR mode requires an open PR.",
    });
  }

  return { ok: failures.length === 0, failures };
}
