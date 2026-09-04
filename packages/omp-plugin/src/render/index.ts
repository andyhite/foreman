export { renderIssueDescription } from "./issue-description.ts";
export type { IssueDescriptionInput } from "./issue-description.ts";

// The PR body is never rendered here: it is authored by the implement agent
// at PR-creation time from `skills/foreman-implement-issue/pr-body.md`, and
// the extension only ever reads the PR back — it never rewrites the body.

export { renderSpikeIssue } from "./spike.ts";

export { renderReviewComment } from "./review-comment.ts";
export { renderImplementComment } from "./implement-comment.ts";


export { renderBlockComment } from "./block-comment.ts";

export { renderStatusConsole } from "./status.ts";
export type { BlockedEntry, RunningEntry, StatusState } from "./status.ts";
