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
  PlanResult,
  RefineResult,
  ResolvedRepoEntry,
  ReviewResult,
  TriageProposal,
} from "@foreman/core";
import {
  AGENT_LABEL,
  BLOCKED_LABEL,
  LEGACY_LABEL,
  encodeMarker,
  MARKER_KIND,
  resolveState,
  TYPE_LABEL,
  resolveTeamKey,
} from "@foreman/core";
import {
  renderBlockComment,
  renderIssueDescription,
  renderProposalComment,
  renderReviewComment,
  renderSpikeIssue,
} from "../render/index.ts";

/** The discriminated union `parseAgentOutput` returns per agent, narrowed to `result | block`. */
export type AgentOutcome =
  | { kind: "result"; agent: "foreman-triage"; result: TriageProposal }
  | { kind: "result"; agent: "foreman-plan"; result: PlanResult }
  | { kind: "result"; agent: "foreman-refine"; result: RefineResult }
  | { kind: "result"; agent: "foreman-implement"; result: ImplementResult }
  | { kind: "result"; agent: "foreman-review"; result: ReviewResult }
  | { kind: "blocked"; agent: string; block: BlockRecord; issueId: string };

/** The Linear/GitHub surface `apply` needs. Injected for testability. */
export interface ApplyDeps {
  linear: LinearWriter;
  github: GitHubClient;
  now: () => Date;
  /** Only `applyPlan` needs this, to resolve the team a new issue must carry (SPEC §7.6). */
  entry?: Pick<ResolvedRepoEntry, "team">;
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

/**
 * Linear drops an API-created issue into the team's default state, which on a
 * triage-enabled team is `Triage` - the shared inbox `foreman team` consumes
 * (§7.1). Every issue the extension creates is already classified, so it has
 * to name Backlog explicitly (§7.2 sub-issues, §7.3 `discoveredWork`, §7.6
 * plan), or agent-authored work re-enters intake as if a human had filed it.
 */
async function backlogStateId(deps: ApplyDeps, teamId: string): Promise<string> {
  const states = await deps.linear.workflowStates(teamId);
  return resolveState("backlog", states).id;
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

  const needsBacklog = result.subIssues.length > 0 || result.spikeCreated !== null;
  const backlog = needsBacklog ? await backlogStateId(deps, issue.team.id) : null;

  for (const subIssue of result.subIssues) {
    const subDescription = renderIssueDescription({
      context: subIssue.description,
      acceptanceCriteria: subIssue.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: [],
    });
    const subTypeLabel = await deps.linear.ensureLabel(subIssue.type, issue.team.id);
    await deps.linear.createIssue({
      teamId: issue.team.id,
      title: subIssue.title,
      description: subDescription,
      estimate: subIssue.estimate,
      parentId: issue.id,
      projectId: issue.project?.id,
      labelIds: [subTypeLabel.id],
      stateId: backlog ?? undefined,
    });
  }

  if (result.spikeCreated) {
    const spikeBody = renderSpikeIssue(result.spikeCreated, { identifier: issue.identifier });
    const spikeTypeLabel = await deps.linear.ensureLabel(TYPE_LABEL.spike, issue.team.id);
    const spike = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: result.spikeCreated.title,
      description: spikeBody,
      projectId: issue.project?.id,
      labelIds: [spikeTypeLabel.id],
      stateId: backlog ?? undefined,
    });
    await deps.linear.createRelation({
      issueId: spike.id,
      relatedIssueId: issue.id,
      type: "blocks",
    });
  }

  if (result.readyForImplementation) await moveToState(deps, issue, "todo");
  await releaseLock(deps, issue);
}

/** SPEC §7.3: move to In Review, file `discoveredWork` as new Backlog issues with native relations, comment the result, release the lock. */
async function applyImplement(deps: ApplyDeps, result: ImplementResult): Promise<void> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ImplementResult references unknown issue ${result.issueId}.`);

  const backlog = result.discoveredWork.length > 0 ? await backlogStateId(deps, issue.team.id) : null;

  for (const discovered of result.discoveredWork) {
    const discoveredTypeLabel = await deps.linear.ensureLabel(discovered.type, issue.team.id);
    const created = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: discovered.title,
      description: discovered.description,
      projectId: issue.project?.id,
      labelIds: [discoveredTypeLabel.id],
      stateId: backlog ?? undefined,
    });
    // `blocks` means "the discovered issue blocks this one" (SPEC schema
    // wording), the orientation `blockedByRelations` reads as incoming.
    await deps.linear.createRelation({
      issueId: discovered.relation === "blocks" ? created.id : issue.id,
      relatedIssueId: discovered.relation === "blocks" ? issue.id : created.id,
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
 * SPEC §7.6: creates each `proposedIssue` as a new Backlog issue under the
 * project. Nothing else — plan never claims `agent:running`, so there is no
 * lock to release, and it never touches an existing issue's state.
 */
async function applyPlan(deps: ApplyDeps, result: PlanResult): Promise<void> {
  const project = await deps.linear.project(result.projectId);
  if (!project) throw new Error(`PlanResult references unknown project ${result.projectId}.`);
  if (result.proposedIssues.length === 0) return;
  if (!deps.entry) throw new Error("applyPlan requires deps.entry to resolve the team.");

  const teams = await deps.linear.teams();
  const teamKey = await resolveTeamKey({ linear: { teams: async () => teams }, entryTeam: deps.entry.team });
  const teamRef = teams.find((candidate) => candidate.key === teamKey);
  if (!teamRef) throw new Error(`Team "${teamKey}" was not found while applying a plan result.`);

  const backlog = await backlogStateId(deps, teamRef.id);

  for (const proposed of result.proposedIssues) {
    const description = renderIssueDescription({
      context: proposed.description,
      acceptanceCriteria: proposed.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: result.outOfScope,
    });
    const typeLabel = await deps.linear.ensureLabel(proposed.type, teamRef.id);
    await deps.linear.createIssue({
      teamId: teamRef.id,
      title: proposed.title,
      description,
      priority: proposed.proposedPriority,
      estimate: proposed.proposedEstimate ?? undefined,
      projectId: result.projectId,
      labelIds: [typeLabel.id],
      stateId: backlog,
    });
  }

  await deps.linear.updateProjectStatus({ projectId: result.projectId, type: "planned" });
}

/**
 * SPEC §13.4/§19: always comment the rendering and write a `review` marker
 * so `hasReviewForHead` detects completion. A `blocking` finding routes the
 * issue back to Todo for the fix cycle; a clean result leaves merging
 * entirely to the operator — no auto-merge, ever. The lock is released
 * either way: review is a terminal result.
 */
async function applyReview(deps: ApplyDeps, result: ReviewResult): Promise<void> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ReviewResult references unknown issue ${result.issueId}.`);

  const human = renderReviewComment(result);
  const body = encodeMarker(MARKER_KIND.review, result, human);
  await deps.linear.createComment({ issueId: issue.id, body });
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  if (blocking.length > 0) await moveToState(deps, issue, "todo");
  await releaseLock(deps, issue);
}

/** SPEC §9 Case A: a `dependency` block creates/verifies the relation, no `blocked:*` label, back to Todo. */
async function applyDependencyBlock(deps: ApplyDeps, issue: Issue, block: BlockRecord): Promise<void> {
  for (const blockerId of block.blockedByIssues) {
    const blocker = await deps.linear.issue(blockerId);
    if (!blocker) continue;
    // The blocker blocks THIS issue — `blockedByRelations` (core) reads
    // "blocked by" as `direction === "incoming"`, which only holds when the
    // relation is written {issueId: blocker, relatedIssueId: issue}.
    const alreadyRelated = issue.relations.some(
      (relation) =>
        relation.type === "blocks" &&
        relation.direction === "incoming" &&
        relation.other.id === blocker.id,
    );
    if (!alreadyRelated) {
      await deps.linear.createRelation({
        issueId: blocker.id,
        relatedIssueId: issue.id,
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

/** Marks a dispatch id as applied (SPEC contract item 3's idempotency mechanism). Uses its own marker kind, distinct from `MARKER_KIND.applied` (the triage-proposal apply marker `hasLaterApplied` scans), so the two dedup mechanisms never collide. */
export async function markApplied(deps: ApplyDeps, issueId: string, dispatchId: string): Promise<void> {
  const issue = await deps.linear.issue(issueId);
  if (!issue) return;
  const body = encodeMarker(MARKER_KIND.dispatchApplied, { dispatchId }, `Applied dispatch \`${dispatchId}\`.`);
  await deps.linear.createComment({ issueId: issue.id, body });
}

/**
 * Dispatches one `AgentOutcome` to the matching applier. A blocked outcome
 * with no `issueId` (only possible for `foreman-plan`, which operates on a
 * project rather than an issue) has nothing to write to — Linear has no
 * project-level `blocked:*` surface — so it is a documented no-op; the block
 * is still visible in the loop's own log and `/foreman-status`.
 */
export async function applyOutcome(deps: ApplyDeps, outcome: AgentOutcome): Promise<void> {
  if (outcome.kind === "blocked") {
    if (!outcome.issueId) return;
    await applyBlock(deps, outcome.issueId, outcome.block);
    return;
  }
  if (outcome.agent === "foreman-triage") {
    await applyTriage(deps, outcome.result);
  } else if (outcome.agent === "foreman-plan") {
    await applyPlan(deps, outcome.result);
  } else if (outcome.agent === "foreman-refine") {
    await applyRefine(deps, outcome.result);
  } else if (outcome.agent === "foreman-implement") {
    await applyImplement(deps, outcome.result);
  } else {
    await applyReview(deps, outcome.result);
  }
}
