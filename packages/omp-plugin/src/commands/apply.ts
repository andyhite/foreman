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

import type { AppliedProposal, LinearWriter, ResolvedRepoEntry, TriageItem } from "@foreman/core";
import {
  AGENT_LABEL,
  applyProposal,
  assertIssueInScope,
  findApprovedUnapplied,
  hasLaterApplied,
  hasLaterReject,
  latestProposal,
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

  let viewerId: string | null;
  try {
    viewerId = await linear.viewerId();
  } catch {
    viewerId = null;
  }
  if (viewerId === null) {
    return { ok: false, mutated: false, message: "Cannot verify proposal authorship (Linear viewer id unavailable); refusing to apply." };
  }

  if (argv.length === 0) {
    const candidates = await findApprovedUnapplied(linear, { authoredBy: viewerId });
    const inScope: typeof candidates = [];
    let outOfScope = 0;
    for (const candidate of candidates) {
      if (!entry) {
        inScope.push(candidate);
        continue;
      }
      try {
        await assertIssueInScope({ linear, entry }, candidate.issue);
        inScope.push(candidate);
      } catch {
        outOfScope += 1;
      }
    }
    const message = [
      inScope.length > 0 ? `${inScope.length} approved proposal(s) pending apply.` : "Nothing to apply.",
      outOfScope > 0 ? `${outOfScope} skipped: not bound to this repo's initiatives.` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" ");
    return {
      ok: true,
      mutated: false,
      message,
      plan: inScope.map((candidate) => ({ issueId: candidate.issue.identifier, item: candidate.item })),
    };
  }

  if (argv.length === 1 && argv[0] === "--yes") {
    const candidates = await findApprovedUnapplied(linear, { authoredBy: viewerId });
    const inScope: typeof candidates = [];
    let outOfScope = 0;
    for (const candidate of candidates) {
      if (!entry) {
        inScope.push(candidate);
        continue;
      }
      try {
        await assertIssueInScope({ linear, entry }, candidate.issue);
        inScope.push(candidate);
      } catch {
        outOfScope += 1;
      }
    }
    const applied: AppliedProposal[] = [];
    const failures: Array<{ identifier: string; error: string }> = [];
    for (const candidate of inScope) {
      try {
        applied.push(await applyProposal(linear, candidate));
      } catch (error) {
        failures.push({
          identifier: candidate.issue.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const lines = [`Applied ${applied.length} approved proposal(s).`];
    for (const failure of failures) {
      lines.push(`- ${failure.identifier}: failed to apply: ${failure.error}`);
    }
    if (outOfScope > 0) lines.push(`${outOfScope} skipped: not bound to this repo's initiatives.`);
    return { ok: failures.length === 0, mutated: applied.length > 0, message: lines.join("\n") };
  }

  const [issueId, flag, ...rest] = argv;
  if (!issueId || !flag) return { ok: false, mutated: false, message: usage };

  const issue = await linear.issue(issueId, { includeComments: true });
  if (!issue) return { ok: false, mutated: false, message: `Unknown issue "${issueId}".` };
  if (entry) await assertIssueInScope({ linear, entry }, issue);


  if (flag === "--approve" && rest.length === 0) {
    const found = latestProposal(issue, viewerId);
    if (!found) return { ok: false, mutated: false, message: `${issueId} has no proposal marker.` };
    if (hasLaterApplied(issue, found.createdAt, viewerId)) {
      return { ok: false, mutated: false, message: `${issueId} was already applied.` };
    }
    if (hasLaterReject(issue, found.createdAt, viewerId)) {
      return { ok: false, mutated: false, message: `${issueId} has a reject: reply; cannot approve.` };
    }

    const proposedLabel = issue.labels.find((label) => label.name === AGENT_LABEL.proposed);
    try {
      await applyProposal(linear, { issue, item: found.data, proposedAt: found.createdAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, mutated: false, message: `Could not apply ${issueId}: ${message}` };
    }
    if (proposedLabel) {
      await linear.updateIssue(issue.id, { removedLabelIds: [proposedLabel.id] });
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
