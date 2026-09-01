/**
 * `/foreman:merge <ISSUE-ID>` — operator-invoked only, never loop-invoked
 * (SPEC §19, §3.10). Checks the review gate, then merges via `gh pr merge`
 * in PR mode or a local merge in direct-branch mode, deleting the branch if
 * configured. Refuses with the gate failures when it does not pass.
 */

import type { GitHubClient, LinearWriter, MergedRecord, ResolvedRepoEntry } from "@foreman/core";
import { assertIssueInScope, encodeMarker, latestMarker, MARKER_KIND, resolveState, reviewGate } from "@foreman/core";
import type { ReviewResult } from "@foreman/core";
import { getEntry } from "../runtime.ts";

export interface MergeCommandResult {
  merged: boolean;
  message: string;
}

/**
 * The newest review marker, restricted to comments authored by the
 * credential's own Linear user. When `authoredBy` is null (viewer id
 * unavailable), every marker is treated as untrusted — the review gate then
 * fails closed rather than letting a forged clean review through.
 */
function latestReview(
  comments: readonly { id: string; body: string; createdAt: string; user: { id: string } | null }[],
  authoredBy: string | null,
): ReviewResult | null {
  if (authoredBy === null) return null;
  return latestMarker<ReviewResult>(MARKER_KIND.review, comments, { authoredBy })?.data ?? null;
}

export async function runMerge(
  linear: LinearWriter,
  github: GitHubClient,
  issueId: string,
  entry: ResolvedRepoEntry = getEntry(),
): Promise<MergeCommandResult> {
  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { merged: false, message: `Unknown issue "${issueId}".` };
  if (!issue.project) return { merged: false, message: `${issueId} has no project; cannot resolve its repo.` };

  await assertIssueInScope({ linear, entry }, issue);
  const repoPath = entry.repoPath;
  const repoSettings = entry;
  const branch = issue.branchName;

  let viewerId: string | null;
  try {
    viewerId = await linear.viewerId();
  } catch {
    viewerId = null;
  }

  const states = await linear.workflowStates(issue.team.id);
  const done = resolveState("done", states);
  if (issue.state.id === done.id) {
    return { merged: true, message: `${issueId} is already Done.` };
  }

  let pr = await github.prForBranch(repoPath, branch, { base: repoSettings.baseBranch });
  let gitMergeComplete = false;
  let mergedPrNumber: number | null = null;

  if (repoSettings.pr.required) {
    if (pr?.state.toLowerCase() === "merged") {
      gitMergeComplete = true;
      mergedPrNumber = pr.number;
    } else {
      const anyPr = await github.prForBranch(repoPath, branch, { base: repoSettings.baseBranch, state: "all" });
      if (anyPr?.state.toUpperCase() === "MERGED") {
        gitMergeComplete = true;
        mergedPrNumber = anyPr.number;
      }
    }
  } else {
    const mergedMarker =
      viewerId !== null
        ? latestMarker<MergedRecord>(MARKER_KIND.merged, issue.comments, { authoredBy: viewerId })
        : null;
    gitMergeComplete = mergedMarker !== null;
  }

  if (!gitMergeComplete) {
    const headSha = pr?.headSha ?? null;
    const ciStatus = headSha ? await github.ciStatus(repoPath, headSha) : "none";
    const review = latestReview(issue.comments, viewerId);

    const gate = reviewGate({
      issue,
      review,
      headSha,
      ciStatus,
      prOpen: pr !== null && pr.state.toLowerCase() === "open",
      prRequired: repoSettings.pr.required,
      ciRequired: repoSettings.pr.ciRequired,
    });

    if (!gate.ok) {
      const bullets = gate.failures.map((failure) => `- ${failure.message}`).join("\n");
      return { merged: false, message: `review gate: fail\n${bullets}` };
    }

    if (repoSettings.pr.required) {
      if (!pr) return { merged: false, message: `No open PR found for branch ${branch}.` };
      await github.mergePr(repoPath, pr.number, repoSettings.merge.strategy, repoSettings.merge.deleteBranch);
      mergedPrNumber = pr.number;
    } else {
      const mergeCommit = await github.mergeBranchLocally(
        repoPath,
        branch,
        repoSettings.baseBranch,
        repoSettings.merge.strategy,
        repoSettings.merge.deleteBranch,
      );
      const body = encodeMarker(
        MARKER_KIND.merged,
        {
          issueId: issue.identifier,
          branch,
          baseBranch: repoSettings.baseBranch,
          mergeCommit,
          strategy: repoSettings.merge.strategy,
          mergedAt: new Date().toISOString(),
        },
        `Merged \`${branch}\` into \`${repoSettings.baseBranch}\` at \`${mergeCommit}\` via ${repoSettings.merge.strategy}.`,
      );
      await linear.createComment({ issueId: issue.id, body });
    }
  }

  try {
    await linear.updateIssue(issue.id, { stateId: done.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mergeDesc =
      mergedPrNumber !== null
        ? `PR #${mergedPrNumber} merged`
        : `Branch \`${branch}\` merged into \`${repoSettings.baseBranch}\``;
    return {
      merged: false,
      message:
        `${mergeDesc}; ${issueId} could NOT be moved to Done: ${message}\n` +
        `Re-run \`/foreman:merge ${issueId}\` to finish the Linear transition.`,
    };
  }

  if (gitMergeComplete) {
    const via = mergedPrNumber !== null ? `PR #${mergedPrNumber}` : `local ${repoSettings.merge.strategy}`;
    return { merged: true, message: `Moved ${issueId} to Done (git merge via ${via} was already complete).` };
  }

  const via = mergedPrNumber !== null ? `PR #${mergedPrNumber}` : repoSettings.merge.strategy;
  return { merged: true, message: `Merged ${issueId} (${branch}) via ${via}; moved to Done.` };
}
