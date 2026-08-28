/**
 * `/foreman:apply` — SPEC §7.1: applying an approved `TriageProposal` item is
 * deterministic, so this is extension code, not a re-dispatch of an agent.
 *
 * Owns the whole proposal-resolution surface (per-item accept/reject too —
 * the board's review screen routes through this command rather than opening
 * a second write path). Exactly four argument shapes:
 *
 *   /foreman:apply                        bulk plan, no mutation
 *   /foreman:apply --yes                  bulk execute
 *   /foreman:apply <ISSUE-ID> --approve
 *   /foreman:apply <ISSUE-ID> --reject <reason>
 *
 * Approve by removing `agent:proposed` is still a valid manual approval path
 * (SPEC §7.1) — bulk/`--yes` picks those up too. This command's `--approve`
 * is the same action taken deliberately for one issue.
 */

import type { Issue, LinearWriter, TriageItem } from "@foreman/core";
import {
  AGENT_LABEL,
  MARKER_KIND,
  encodeMarker,
  findMarkers,
  resolveState,
} from "@foreman/core";
import type { FoundMarker } from "@foreman/core";

export interface ApplyPlanEntry {
  issueId: string;
  item: TriageItem;
}

export interface ApplyCommandResult {
  ok: boolean;
  mutated: boolean;
  message: string;
  plan?: ApplyPlanEntry[];
}

function latestProposal(issue: Issue): FoundMarker<TriageItem> | null {
  const markers = findMarkers<TriageItem>(MARKER_KIND.proposal, issue.comments);
  return markers[markers.length - 1] ?? null;
}

function hasLaterApplied(issue: Issue, afterCreatedAt: string): boolean {
  return findMarkers(MARKER_KIND.applied, issue.comments).some((marker) => marker.createdAt > afterCreatedAt);
}

function hasLaterReject(issue: Issue, afterCreatedAt: string): boolean {
  return issue.comments.some(
    (comment) => comment.createdAt > afterCreatedAt && comment.body.trim().toLowerCase().startsWith("reject:"),
  );
}

function isCurrentlyProposed(issue: Issue): boolean {
  return issue.labels.some((label) => label.name === AGENT_LABEL.proposed);
}

/** Every issue whose latest proposal is approved (label removed), un-rejected, and not yet applied. */
async function findApprovedUnapplied(linear: LinearWriter): Promise<Array<{ issue: Issue; found: FoundMarker<TriageItem> }>> {
  const issues = await linear.issues({ includeComments: true, limit: 500 });
  const candidates: Array<{ issue: Issue; found: FoundMarker<TriageItem> }> = [];
  for (const issue of issues) {
    const found = latestProposal(issue);
    if (!found) continue;
    if (isCurrentlyProposed(issue)) continue;
    if (hasLaterApplied(issue, found.createdAt)) continue;
    if (hasLaterReject(issue, found.createdAt)) continue;
    candidates.push({ issue, found });
  }
  return candidates;
}

/** SPEC §7.1: destination, type label, priority, project, duplicate relation, proposed blockers, then the applied marker. */
async function applyProposalItem(linear: LinearWriter, issue: Issue, item: TriageItem, dispatchMarkerCreatedAt: string): Promise<void> {
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

  // `destinationProject` names a project, never a UUID (SPEC §7.1); an
  // unmatched name must not silently drop the rest of the mutation, so it is
  // folded into the same applied-marker note the file already uses to
  // report what happened, rather than failing the whole apply.
  let projectNote = "";
  if (item.destinationProject) {
    const projects = await linear.projects();
    const destinationProject = item.destinationProject;
    const match = projects.find((candidate) => candidate.name.toLowerCase() === destinationProject.toLowerCase());
    if (match) {
      mutation.projectId = match.id;
    } else {
      projectNote = ` Proposed project "${destinationProject}" not found; project left unset.`;
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
    { issueId: issue.identifier, appliedProposalAt: dispatchMarkerCreatedAt },
    `Applied the \`${item.type}\` proposal: moved to ${item.destination}, priority set.${projectNote}`,
  );
  await linear.createComment({ issueId: issue.id, body });
}

/** `/foreman:apply` — dispatches to the shape named by `argv` (already tokenized, without the leading slash-command name). */
export async function runApplyCommand(linear: LinearWriter, argv: string[]): Promise<ApplyCommandResult> {
  const usage =
    'Usage: /foreman:apply | /foreman:apply --yes | /foreman:apply <ISSUE-ID> --approve | /foreman:apply <ISSUE-ID> --reject <reason>';

  if (argv.length === 0) {
    const candidates = await findApprovedUnapplied(linear);
    return {
      ok: true,
      mutated: false,
      message: candidates.length > 0 ? `${candidates.length} approved proposal(s) pending apply.` : "Nothing to apply.",
      plan: candidates.map(({ issue, found }) => ({ issueId: issue.identifier, item: found.data })),
    };
  }

  if (argv.length === 1 && argv[0] === "--yes") {
    const candidates = await findApprovedUnapplied(linear);
    for (const { issue, found } of candidates) {
      await applyProposalItem(linear, issue, found.data, found.createdAt);
    }
    return { ok: true, mutated: true, message: `Applied ${candidates.length} approved proposal(s).` };
  }

  const [issueId, flag, ...rest] = argv;
  if (!issueId || !flag) return { ok: false, mutated: false, message: usage };

  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { ok: false, mutated: false, message: `Unknown issue "${issueId}".` };

  if (flag === "--approve" && rest.length === 0) {
    const found = latestProposal(issue);
    if (!found) return { ok: false, mutated: false, message: `${issueId} has no proposal marker.` };
    if (hasLaterApplied(issue, found.createdAt)) {
      return { ok: false, mutated: false, message: `${issueId} was already applied.` };
    }
    if (hasLaterReject(issue, found.createdAt)) {
      return { ok: false, mutated: false, message: `${issueId} has a reject: reply; cannot approve.` };
    }

    const proposedLabel = issue.labels.find((label) => label.name === AGENT_LABEL.proposed);
    if (proposedLabel) {
      await linear.updateIssue(issue.id, { removedLabelIds: [proposedLabel.id] });
    }
    await applyProposalItem(linear, issue, found.data, found.createdAt);
    return { ok: true, mutated: true, message: `Approved and applied ${issueId}.` };
  }

  if (flag === "--reject") {
    const reason = rest.join(" ").trim();
    if (reason.length === 0) return { ok: false, mutated: false, message: `${usage} (reason required)` };
    const body = `reject: ${reason}`;
    await linear.createComment({ issueId: issue.id, body });
    return { ok: true, mutated: true, message: `Rejected ${issueId}: ${reason}` };
  }

  return { ok: false, mutated: false, message: usage };
}
