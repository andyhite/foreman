/**
 * `/foreman:merge <ISSUE-ID>` — operator-invoked only, never loop-invoked
 * (SPEC §19, §3.10). Checks the review gate, then merges via `gh pr merge`
 * in PR mode or a local merge in direct-branch mode, deleting the branch if
 * configured. Refuses with the gate failures when it does not pass.
 */

import type { GitHubClient, LinearWriter } from "@foreman/core";
import { decodeMarker, gateSummary, MARKER_KIND, repoForProject, resolveRepoConfig, reviewGate } from "@foreman/core";
import type { ReviewResult } from "@foreman/core";
import { getConfig } from "../runtime.ts";

export interface MergeCommandResult {
  merged: boolean;
  message: string;
}

function latestReview(comments: readonly { body: string; createdAt: string }[]): ReviewResult | null {
  let latest: { data: ReviewResult; createdAt: string } | null = null;
  for (const comment of comments) {
    const data = decodeMarker<ReviewResult>(MARKER_KIND.review, comment.body) ?? decodeMarker<ReviewResult>(MARKER_KIND.findings, comment.body);
    if (!data) continue;
    if (!latest || comment.createdAt > latest.createdAt) latest = { data, createdAt: comment.createdAt };
  }
  return latest?.data ?? null;
}

export async function runMerge(linear: LinearWriter, github: GitHubClient, issueId: string): Promise<MergeCommandResult> {
  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { merged: false, message: `Unknown issue "${issueId}".` };
  if (!issue.project) return { merged: false, message: `${issueId} has no project; cannot resolve its repo.` };

  const config = getConfig();
  const repoPath = repoForProject(config, issue.project.id);
  const repoSettings = resolveRepoConfig(config, repoPath);
  const branch = issue.branchName;

  const pr = await github.prForBranch(repoPath, branch);
  const headSha = pr?.headSha ?? null;
  const ciStatus = headSha ? await github.ciStatus(repoPath, headSha) : "none";
  const review = latestReview(issue.comments);

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
    return { merged: false, message: gateSummary("review", gate) };
  }

  if (repoSettings.pr.required) {
    if (!pr) return { merged: false, message: `No open PR found for branch ${branch}.` };
    await github.mergePr(repoPath, pr.number, repoSettings.merge.strategy, repoSettings.merge.deleteBranch);
  } else {
    await github.mergeBranchLocally(repoPath, branch, repoSettings.baseBranch, repoSettings.merge.strategy, repoSettings.merge.deleteBranch);
  }

  return { merged: true, message: `Merged ${issueId} (${branch}) via ${repoSettings.merge.strategy}.` };
}
