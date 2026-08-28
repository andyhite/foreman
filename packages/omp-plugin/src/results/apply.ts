/**
 * Applies a validated agent result to Linear (SPEC §3.5 item 5, principle 9).
 *
 * This is the only place Linear mutations happen for agent-driven work; the
 * extension is the sole writer, so everything an agent wants changed must be
 * expressible in its result schema (SPEC §6) or it does not happen.
 */

import type {
  BlockRecord,
  GitHubClient,
  Issue,
  ImplementResult,
  LinearWriter,
  RefineResult,
  ReviewResult,
  TriageProposal,
} from "@foreman/core";
import {
  AGENT_LABEL,
  BLOCKED_LABEL,
  LEGACY_LABEL,
  encodeMarker,
  MARKER_KIND,
  renderBlockComment,
  renderIssueDescription,
  renderProposalComment,
  renderReviewComment,
  renderSpikeIssue,
  resolveState,
} from "@foreman/core";

/** The discriminated union `parseAgentOutput` returns per agent, narrowed to `result | block`. */
export type AgentOutcome =
  | { kind: "result"; agent: "foreman-triage"; result: TriageProposal }
  | { kind: "result"; agent: "foreman-refine"; result: RefineResult }
  | { kind: "result"; agent: "foreman-implement"; result: ImplementResult }
  | { kind: "result"; agent: "foreman-review"; result: ReviewResult }
  | { kind: "blocked"; agent: string; block: BlockRecord; issueId: string };

/** The Linear/GitHub surface `apply` needs. Injected for testability. */
export interface ApplyDeps {
  linear: LinearWriter;
  github: GitHubClient;
  now: () => Date;
}

async function releaseLock(deps: ApplyDeps, issue: Issue): Promise<void> {
  if (!issue.labels.some((label) => label.name === AGENT_LABEL.running)) return;
  const runningLabel = issue.labels.find((label) => label.name === AGENT_LABEL.running);
  if (!runningLabel) return;
  await deps.linear.updateIssue(issue.id, { removedLabelIds: [runningLabel.id] });
}

async function moveToState(deps: ApplyDeps, issue: Issue, stateKey: Parameters<typeof resolveState>[0]): Promise<void> {
  const states = await deps.linear.workflowStates(issue.team.id);
  const target = resolveState(stateKey, states);
  await deps.linear.updateIssue(issue.id, { stateId: target.id });
}

/** SPEC §7.1: one comment per item, `agent:proposed`, nothing else — no state change, no priority. */
async function applyTriage(deps: ApplyDeps, result: TriageProposal): Promise<void> {
  for (const item of result.items) {
    const issue = await deps.linear.issue(item.issueId);
    if (!issue) continue;
    const human = renderProposalComment(item);
    const body = encodeMarker(MARKER_KIND.proposal, item, human);
    await deps.linear.createComment({ issueId: issue.id, body });
    const proposedLabel = await deps.linear.ensureLabel(AGENT_LABEL.proposed, issue.team.id);
    await deps.linear.updateIssue(issue.id, { addedLabelIds: [proposedLabel.id] });
  }
}

/** SPEC §7.2: description, estimate, sub-issues, spike (with its native `blocks` relation), `agent:ready` only when ready, move to Todo, strip `legacy`. */
async function applyRefine(deps: ApplyDeps, result: RefineResult): Promise<void> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`RefineResult references unknown issue ${result.issueId}.`);

  const description = renderIssueDescription({
    context: result.refinedDescription,
    acceptanceCriteria: result.acceptanceCriteria,
    affectedAreas: result.affectedAreas,
    outOfScope: result.outOfScope,
  });

  const mutation: Parameters<LinearWriter["updateIssue"]>[1] = {
    description,
    estimate: result.estimate,
  };

  const legacyLabel = issue.labels.find((label) => label.name === LEGACY_LABEL);
  if (legacyLabel) mutation.removedLabelIds = [legacyLabel.id];

  if (result.readyForImplementation) {
    const readyLabel = await deps.linear.ensureLabel(AGENT_LABEL.ready, issue.team.id);
    mutation.addedLabelIds = [...(mutation.addedLabelIds ?? []), readyLabel.id];
  }

  await deps.linear.updateIssue(issue.id, mutation);

  for (const subIssue of result.subIssues) {
    const subDescription = renderIssueDescription({
      context: subIssue.description,
      acceptanceCriteria: subIssue.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: [],
    });
    await deps.linear.createIssue({
      teamId: issue.team.id,
      title: subIssue.title,
      description: subDescription,
      estimate: subIssue.estimate,
      parentId: issue.id,
      projectId: issue.project?.id,
    });
  }

  if (result.spikeCreated) {
    const spikeBody = renderSpikeIssue(result.spikeCreated, { identifier: issue.identifier });
    const spike = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: result.spikeCreated.title,
      description: spikeBody,
      projectId: issue.project?.id,
    });
    await deps.linear.createRelation({
      issueId: spike.id,
      relatedIssueId: issue.id,
      type: "blocks",
    });
  }

  await moveToState(deps, issue, "todo");
}

/** SPEC §7.3: move to In Review, file `discoveredWork` as new Backlog issues with native relations, comment the result, release the lock. */
async function applyImplement(deps: ApplyDeps, result: ImplementResult): Promise<void> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ImplementResult references unknown issue ${result.issueId}.`);

  for (const discovered of result.discoveredWork) {
    const created = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: discovered.title,
      description: discovered.description,
      projectId: issue.project?.id,
    });
    await deps.linear.createRelation({
      issueId: discovered.relation === "blocks" ? issue.id : created.id,
      relatedIssueId: discovered.relation === "blocks" ? created.id : issue.id,
      type: discovered.relation,
    });
  }

  const humanSummary = [
    `**Branch:** ${result.branch}`,
    result.prUrl.length > 0 ? `**PR:** ${result.prUrl}` : "**PR:** none (direct-branch mode)",
    `**Approach:** ${result.approachSummary}`,
  ].join("\n");
  const body = encodeMarker(MARKER_KIND.implement, result, humanSummary);
  await deps.linear.createComment({ issueId: issue.id, body });

  await moveToState(deps, issue, "inReview");
  await releaseLock(deps, issue);
}

/**
 * SPEC §13.4/§19: comment the rendering; a `blocking` finding writes a
 * `foreman:findings` marker and leaves the issue for the fix cycle. A clean
 * result leaves merging entirely to the operator — no auto-merge, ever.
 */
async function applyReview(deps: ApplyDeps, result: ReviewResult): Promise<void> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ReviewResult references unknown issue ${result.issueId}.`);

  const human = renderReviewComment(result);
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  const body =
    blocking.length > 0 ? encodeMarker(MARKER_KIND.findings, result, human) : human;
  await deps.linear.createComment({ issueId: issue.id, body });
}

/** SPEC §9 Case A: a `dependency` block creates/verifies the relation, no `blocked:*` label, back to Todo. */
async function applyDependencyBlock(deps: ApplyDeps, issue: Issue, block: BlockRecord): Promise<void> {
  for (const blockerId of block.blockedByIssues) {
    const blocker = await deps.linear.issue(blockerId);
    if (!blocker) continue;
    const alreadyRelated = issue.relations.some(
      (relation) =>
        relation.type === "blocks" &&
        relation.direction === "incoming" &&
        relation.other.id === blocker.id,
    );
    if (!alreadyRelated) {
      await deps.linear.createRelation({
        issueId: issue.id,
        relatedIssueId: blocker.id,
        type: "blocks",
      });
    }
  }
  const body = renderBlockComment(block);
  await deps.linear.createComment({ issueId: issue.id, body });
  await releaseLock(deps, issue);
  await moveToState(deps, issue, "todo");
}

const BLOCK_TYPE_LABEL: Record<Exclude<BlockRecord["type"], "dependency">, string> = {
  "needs-input": BLOCKED_LABEL.needsInput,
  "needs-decision": BLOCKED_LABEL.needsDecision,
  external: BLOCKED_LABEL.external,
  budget: BLOCKED_LABEL.needsInput,
};

/** SPEC §9 Case B: every other block type applies the matching `blocked:*` label, comments, releases the lock, back to Todo. */
async function applyHumanBlock(deps: ApplyDeps, issue: Issue, block: BlockRecord): Promise<void> {
  const labelName = BLOCK_TYPE_LABEL[block.type as Exclude<BlockRecord["type"], "dependency">];
  const label = await deps.linear.ensureLabel(labelName, issue.team.id);
  await deps.linear.updateIssue(issue.id, { addedLabelIds: [label.id] });
  const body = encodeMarker(MARKER_KIND.block, block, renderBlockComment(block));
  await deps.linear.createComment({ issueId: issue.id, body });
  await releaseLock(deps, issue);
  await moveToState(deps, issue, "todo");
}

/** Routes a `BlockRecord` through SPEC §9 instead of the normal result path. */
export async function applyBlock(deps: ApplyDeps, issueId: string, block: BlockRecord): Promise<void> {
  const issue = await deps.linear.issue(issueId);
  if (!issue) throw new Error(`Block references unknown issue ${issueId}.`);

  if (block.type === "dependency") {
    await applyDependencyBlock(deps, issue, block);
  } else {
    await applyHumanBlock(deps, issue, block);
  }
}

/** Marks a dispatch id as applied (SPEC contract item 3's idempotency mechanism). */
export async function markApplied(deps: ApplyDeps, issueId: string, dispatchId: string): Promise<void> {
  const issue = await deps.linear.issue(issueId);
  if (!issue) return;
  const body = encodeMarker(MARKER_KIND.applied, { dispatchId }, `Applied dispatch \`${dispatchId}\`.`);
  await deps.linear.createComment({ issueId: issue.id, body });
}

/** Dispatches one `AgentOutcome` to the matching applier. */
export async function applyOutcome(deps: ApplyDeps, outcome: AgentOutcome): Promise<void> {
  if (outcome.kind === "blocked") {
    await applyBlock(deps, outcome.issueId, outcome.block);
    return;
  }
  if (outcome.agent === "foreman-triage") {
    await applyTriage(deps, outcome.result);
  } else if (outcome.agent === "foreman-refine") {
    await applyRefine(deps, outcome.result);
  } else if (outcome.agent === "foreman-implement") {
    await applyImplement(deps, outcome.result);
  } else {
    await applyReview(deps, outcome.result);
  }
}
