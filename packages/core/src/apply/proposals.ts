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

/** The newest proposal marker on `issue`, or null. */
export function latestProposal(issue: Issue): FoundMarker<TriageItem> | null {
  const markers = findMarkers<TriageItem>(MARKER_KIND.proposal, issue.comments);
  return markers[markers.length - 1] ?? null;
}

export function hasLaterApplied(issue: Issue, afterCreatedAt: string): boolean {
  return findMarkers(MARKER_KIND.applied, issue.comments).some((marker) => marker.createdAt > afterCreatedAt);
}

export function hasLaterReject(issue: Issue, afterCreatedAt: string): boolean {
  return issue.comments.some(
    (comment) => comment.createdAt > afterCreatedAt && comment.body.trim().toLowerCase().startsWith("reject:"),
  );
}

export function isCurrentlyProposed(issue: Issue): boolean {
  return issue.labels.some((label) => label.name === AGENT_LABEL.proposed);
}

/** Pure predicate over already-fetched issues. No I/O. */
export function proposalCandidates(issues: readonly Issue[]): ProposalCandidate[] {
  const candidates: ProposalCandidate[] = [];
  for (const issue of issues) {
    const found = latestProposal(issue);
    if (!found) continue;
    if (isCurrentlyProposed(issue)) continue;
    if (hasLaterApplied(issue, found.createdAt)) continue;
    if (hasLaterReject(issue, found.createdAt)) continue;
    candidates.push({ issue, item: found.data, proposedAt: found.createdAt });
  }
  return candidates;
}

/** Fetches (comments included) then filters. `filter` narrows the scan. */
export async function findApprovedUnapplied(
  linear: LinearWriter,
  options?: { filter?: IssueFilter; limit?: number },
): Promise<ProposalCandidate[]> {
  const issues = await linear.issues({
    filter: options?.filter,
    includeComments: true,
    limit: options?.limit ?? 500,
  });
  return proposalCandidates(issues);
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

  // `destinationProject` names a project, never a UUID (SPEC §7.1). A name
  // can also be ambiguous: `TriageItem` carries no initiative field, so when
  // two projects share a name (every product tends to have a `Maintenance`
  // project) there is no signal in the proposal that resolves which one the
  // issue belongs to. Guessing would silently misfile the issue, which is
  // worse than leaving the project unset, so both the not-found and the
  // ambiguous case fold into the same applied-marker note instead of failing
  // the rest of the mutation.
  let projectNote: string | null = null;
  if (item.destinationProject) {
    const projects = await linear.projects();
    const destinationProject = item.destinationProject;
    const matches = projects.filter((candidate) => candidate.name.toLowerCase() === destinationProject.toLowerCase());
    if (matches.length === 1 && matches[0]) {
      mutation.projectId = matches[0].id;
    } else if (matches.length === 0) {
      projectNote = `Proposed project "${destinationProject}" not found; project left unset.`;
    } else {
      projectNote = `Proposed project "${destinationProject}" is ambiguous (${matches.length} projects share that name); project left unset.`;
    }
  }

  await linear.updateIssue(issue.id, mutation);

  if (item.duplicateOf) {
    const duplicate = await linear.issue(item.duplicateOf);
    if (duplicate) {
      await linear.createRelation({ issueId: issue.id, relatedIssueId: duplicate.id, type: "duplicate" });
    }
  }

  for (const blockerId of item.proposedBlockedBy) {
    const blocker = await linear.issue(blockerId);
    if (blocker) {
      await linear.createRelation({ issueId: issue.id, relatedIssueId: blocker.id, type: "blocks" });
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

/** find + apply every candidate. Returns what it applied. */
export async function runApplyPass(
  linear: LinearWriter,
  options?: { filter?: IssueFilter; limit?: number },
): Promise<AppliedProposal[]> {
  const candidates = await findApprovedUnapplied(linear, options);
  const applied: AppliedProposal[] = [];
  for (const candidate of candidates) {
    applied.push(await applyProposal(linear, candidate));
  }
  return applied;
}
