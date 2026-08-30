/**
 * The deterministic apply engine for `TriageProposal` items (SPEC §7.1).
 *
 * Applying an approved proposal is mechanical — resolve the destination
 * state, labels, priority, project, and relations, then leave an `applied`
 * marker — so it lives here rather than behind an agent dispatch. Both the
 * `/foreman:apply` extension command and the loop's intake tick (SPEC §3.12)
 * run this exact code; neither may keep its own copy.
 */

import { MARKER_KIND, encodeMarker, findMarkers } from "../markers.ts";
import { AGENT_LABEL } from "../domain/labels.ts";
import { resolveState } from "../domain/states.ts";
import type { IssueFilter, LinearWriter } from "../linear/api.ts";
import type { Issue } from "../linear/types.ts";
import type { TriageItem } from "../schemas/triage.ts";
import type { FoundMarker } from "../markers.ts";

/** An issue whose latest proposal is approved, un-rejected, and not yet applied. */
export interface ProposalCandidate {
  issue: Issue;
  item: TriageItem;
  proposedAt: string;
}

/** What `applyProposal` actually did, for callers that log or report instead of re-deriving it. */
export interface AppliedProposal {
  issueId: string;
  identifier: string;
  destination: string;
  note: string | null;
}

/** The newest proposal marker on `issue`, or null. When `authoredBy` is set, markers not authored by that user id are ignored. */
export function latestProposal(issue: Issue, authoredBy?: string): FoundMarker<TriageItem> | null {
  const markers = findMarkers<TriageItem>(
    MARKER_KIND.proposal,
    issue.comments,
    authoredBy !== undefined ? { authoredBy } : undefined,
  );
  return markers[markers.length - 1] ?? null;
}

/** Only `applied` markers with `appliedProposalAt` are proposal-apply markers (Contract 1); a plugin `dispatchApplied` marker is a different event and must not mask an approved proposal. */
export function hasLaterApplied(issue: Issue, afterCreatedAt: string, authoredBy?: string): boolean {
  return findMarkers<{ appliedProposalAt?: string }>(
    MARKER_KIND.applied,
    issue.comments,
    authoredBy !== undefined ? { authoredBy } : undefined,
  ).some((marker) => marker.createdAt > afterCreatedAt && marker.data.appliedProposalAt !== undefined);
}

export function hasLaterReject(issue: Issue, afterCreatedAt: string, authoredBy?: string): boolean {
  return issue.comments.some((comment) => {
    if (comment.createdAt <= afterCreatedAt) return false;
    if (authoredBy !== undefined && comment.user?.id !== authoredBy) return false;
    const start = comment.body.trim().toLowerCase();
    return start.startsWith("reject:") || start.startsWith("rejected:");
  });
}

export function isCurrentlyProposed(issue: Issue): boolean {
  return issue.labels.some((label) => label.name === AGENT_LABEL.proposed);
}

/** Pure predicate over already-fetched issues. `authoredBy`, when set, restricts every marker read to that user id — a forged proposal/applied/reject marker from another user is invisible. */
export function proposalCandidates(issues: readonly Issue[], authoredBy?: string): ProposalCandidate[] {
  const candidates: ProposalCandidate[] = [];
  for (const issue of issues) {
    const found = latestProposal(issue, authoredBy);
    if (!found) continue;
    if (isCurrentlyProposed(issue)) continue;
    if (hasLaterApplied(issue, found.createdAt, authoredBy)) continue;
    if (hasLaterReject(issue, found.createdAt, authoredBy)) continue;
    candidates.push({ issue, item: found.data, proposedAt: found.createdAt });
  }
  return candidates;
}

/** Fetches (comments included) then filters. `filter` narrows the scan. */
export async function findApprovedUnapplied(
  linear: LinearWriter,
  options?: { filter?: IssueFilter; limit?: number; authoredBy?: string },
): Promise<ProposalCandidate[]> {
  const issues = await linear.issues({
    filter: options?.filter,
    includeComments: true,
    limit: options?.limit ?? 500,
  });
  return proposalCandidates(issues, options?.authoredBy);
}

/** SPEC §7.1: destination, type label, priority, project, duplicate relation, proposed blockers, then the applied marker. */
export async function applyProposal(linear: LinearWriter, candidate: ProposalCandidate): Promise<AppliedProposal> {
  const { issue, item, proposedAt } = candidate;
  const destinationKey = item.destination === "Backlog" ? "backlog" : item.destination === "Canceled" ? "canceled" : "duplicate";
  const teamStates = await linear.workflowStates(issue.team.id);
  const targetState = resolveState(destinationKey, teamStates);

  const typeLabel = await linear.ensureLabel(item.type, issue.team.id);
  const addedLabelIds = [typeLabel.id];

  if (item.triageLabel) {
    const triageLabel = await linear.ensureLabel(item.triageLabel, issue.team.id);
    addedLabelIds.push(triageLabel.id);
  }

  const mutation: Parameters<LinearWriter["updateIssue"]>[1] = {
    stateId: targetState.id,
    priority: item.proposedPriority,
    addedLabelIds,
  };

  if (item.draftDescription) mutation.description = item.draftDescription;
  if (item.proposedEstimate !== null) mutation.estimate = item.proposedEstimate;

  // `destinationProjectId` is authoritative when the agent has it — a real
  // Linear id, never ambiguous. `destinationProject` names a project, never
  // a UUID (SPEC §7.1), and a name can be ambiguous: `TriageItem` carries no
  // initiative field, so when two projects share a name (every product tends
  // to have a `Maintenance` project) there is no signal in the proposal that
  // resolves which one the issue belongs to. Guessing would silently misfile
  // the issue, so a name that resolves to zero or several projects throws —
  // `runApplyPass` isolates the failure per candidate.
  let projectNote: string | null = null;
  if (item.destinationProjectId) {
    mutation.projectId = item.destinationProjectId;
  } else if (item.destinationProject) {
    const projects = await linear.projects();
    const destinationProject = item.destinationProject;
    const matches = projects.filter((candidate) => candidate.name.toLowerCase() === destinationProject.toLowerCase());
    if (matches.length === 1 && matches[0]) {
      mutation.projectId = matches[0].id;
    } else if (matches.length === 0) {
      throw new Error(`Proposed project "${destinationProject}" not found for issue ${issue.identifier}.`);
    } else {
      throw new Error(
        `Proposed project "${destinationProject}" is ambiguous (${matches.length} projects share that name) for issue ${issue.identifier}.`,
      );
    }
  }

  await linear.updateIssue(issue.id, mutation);

  if (item.duplicateOf) {
    const duplicate = await linear.issue(item.duplicateOf);
    if (duplicate) {
      const alreadyRelated = issue.relations.some(
        (relation) =>
          relation.type === "duplicate" &&
          relation.direction === "outgoing" &&
          relation.other.id === duplicate.id,
      );
      if (!alreadyRelated) {
        await linear.createRelation({ issueId: issue.id, relatedIssueId: duplicate.id, type: "duplicate" });
      }
    }
  }

  for (const blockerId of item.proposedBlockedBy) {
    const blocker = await linear.issue(blockerId);
    if (blocker) {
      // `blocker` blocks `issue` (Linear stores "A blocks B" as
      // `{ issueId: A, relatedIssueId: B }`), the same orientation as
      // `applyRefine`'s spike case — not the inverse.
      const alreadyRelated = issue.relations.some(
        (relation) =>
          relation.type === "blocks" &&
          relation.direction === "incoming" &&
          relation.other.id === blocker.id,
      );
      if (!alreadyRelated) {
        await linear.createRelation({ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
      }
    }
  }

  const body = encodeMarker(
    MARKER_KIND.applied,
    { issueId: issue.identifier, appliedProposalAt: proposedAt },
    `Applied the \`${item.type}\` proposal: moved to ${item.destination}, priority set.${projectNote ? ` ${projectNote}` : ""}`,
  );
  await linear.createComment({ issueId: issue.id, body });

  return { issueId: issue.id, identifier: issue.identifier, destination: item.destination, note: projectNote };
}

/** A candidate that failed to apply; the caller decides whether to retry next pass. */
export interface ApplyFailure {
  issueId: string;
  identifier: string;
  error: string;
}

/** The outcome of one `runApplyPass` invocation: what applied cleanly, and what failed and why. */
export interface ApplyPassResult {
  applied: AppliedProposal[];
  failures: ApplyFailure[];
}

/**
 * find + apply every candidate, isolating each: `applyProposal` is not
 * atomic (state, labels, relations, then the marker written last), so one
 * candidate's failure must never abort the batch and hide every remaining
 * approved proposal until the next pass.
 */
export async function runApplyPass(
  linear: LinearWriter,
  options?: { filter?: IssueFilter; limit?: number; authoredBy?: string },
): Promise<ApplyPassResult> {
  const candidates = await findApprovedUnapplied(linear, options);
  const applied: AppliedProposal[] = [];
  const failures: ApplyFailure[] = [];
  for (const candidate of candidates) {
    try {
      applied.push(await applyProposal(linear, candidate));
    } catch (error) {
      failures.push({
        issueId: candidate.issue.id,
        identifier: candidate.issue.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { applied, failures };
}
