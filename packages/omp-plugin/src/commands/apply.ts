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

import type { LinearWriter, ResolvedRepoEntry, TriageItem } from "@foreman/core";
import {
  AGENT_LABEL,
  applyProposal,
  assertIssueInScope,
  findApprovedUnapplied,
  hasLaterApplied,
  hasLaterReject,
  latestProposal,
  runApplyPass,
} from "@foreman/core";

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

/** `/foreman:apply` — dispatches to the shape named by `argv` (already tokenized, without the leading slash-command name). */
export async function runApplyCommand(
  linear: LinearWriter,
  argv: string[],
  entry?: ResolvedRepoEntry,
): Promise<ApplyCommandResult> {
  const usage = [
    "Usage:",
    "  /foreman:apply",
    "  /foreman:apply --yes",
    "  /foreman:apply ENG-1 --approve",
    "  /foreman:apply ENG-1 --reject <reason>",
  ].join("\n");

  if (argv.length === 1 && argv[0] === "--help") {
    return { ok: true, mutated: false, message: usage };
  }

  if (argv.length === 0) {
    const candidates = await findApprovedUnapplied(linear);
    return {
      ok: true,
      mutated: false,
      message: candidates.length > 0 ? `${candidates.length} approved proposal(s) pending apply.` : "Nothing to apply.",
      plan: candidates.map((candidate) => ({ issueId: candidate.issue.identifier, item: candidate.item })),
    };
  }

  if (argv.length === 1 && argv[0] === "--yes") {
    const { applied, failures } = await runApplyPass(linear);
    const lines = [`Applied ${applied.length} approved proposal(s).`];
    for (const proposal of applied) {
      if (proposal.note) lines.push(`- ${proposal.identifier}: ${proposal.note}`);
    }
    for (const failure of failures) {
      lines.push(`- ${failure.identifier}: failed to apply: ${failure.error}`);
    }
    return { ok: failures.length === 0, mutated: applied.length > 0, message: lines.join("\n") };
  }

  const [issueId, flag, ...rest] = argv;
  if (!issueId || !flag) return { ok: false, mutated: false, message: usage };

  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { ok: false, mutated: false, message: `Unknown issue "${issueId}".` };
  if (entry) await assertIssueInScope({ linear, entry }, issue);


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
    try {
      await applyProposal(linear, { issue, item: found.data, proposedAt: found.createdAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, mutated: false, message: `Could not apply ${issueId}: ${message}` };
    }
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
