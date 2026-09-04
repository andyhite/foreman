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
  IssueLabel,
  LinearId,
  LinearWriter,
  PlanResult,
  RefineResult,
  ResolvedRepoEntry,
  ReviewEvent,
  ReviewResult,
  RoadmapResult,
  TeamRef,
  TriageItem,
  TriageResult,
} from "@foreman/core";
import {
  appLabelId,
  applyRoadmap,
  branchNameFor,
  encodeMarker,
  issueScope,
  MARKER_KIND,
  readLockComment,
  renderLockComment,
  resolveState,
  resolveTeamKey,
  sanitizeAgentText,
  stripControlChars,
  TYPE_LABEL,
  TYPE_LABEL_COLOR,
  type TypeLabel,
} from "@foreman/core";
import {
  renderBlockComment,
  renderIssueDescription,
  renderReviewComment,
  renderSpikeIssue,
} from "../render/index.ts";

/** The operator-facing channel `handleCaptured` owns; threaded in rather than imported to keep this module free of extension state. */
export type Notify = (message: string, level: "warn" | "error") => void;

/** The discriminated union `parseAgentOutput` returns per agent, narrowed to `result | block`. */
export type AgentOutcome =
  | { kind: "result"; agent: "foreman-triage"; result: TriageResult }
  | { kind: "result"; agent: "foreman-plan"; result: PlanResult }
  | { kind: "result"; agent: "foreman-roadmap"; result: RoadmapResult }
  | { kind: "result"; agent: "foreman-refine"; result: RefineResult }
  | { kind: "result"; agent: "foreman-implement"; result: ImplementResult }
  | { kind: "result"; agent: "foreman-review"; result: ReviewResult }
  | { kind: "blocked"; agent: string; block: BlockRecord; issueId: string };

/** An issue or project a result created, surfaced back to the operator/loop summary. */
export interface CreatedEntity {
  kind: "issue" | "project";
  id: string;
  identifier: string | null;
  title: string;
  url: string | null;
}

/** What an applier observed while writing to Linear — the whole of what `apply` reports back. */
export interface AppliedFacts {
  subject: string | null;
  summary: string;
  created: CreatedEntity[];
  movedTo: string | null;
}

function createdIssue(issue: Issue): CreatedEntity {
  return { kind: "issue", id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
}

/** The Linear/GitHub surface `apply` needs. Injected for testability. */
export interface ApplyDeps {
  linear: LinearWriter;
  github: GitHubClient;
  now: () => Date;
  /**
   * `applyPlan` and `applyRoadmap` need `team` to resolve the team a new
   * issue or project must carry (SPEC §7.6, §7.7); `applyReview` needs
   * `repoPath`/`branchPattern` to find the PR a GitHub review mirrors onto
   * (SPEC §7.4); `applyTriageItem`/`applyPlan` need `alias`/`team` to refuse
   * an agent-supplied id outside this dispatch's bound team (`issueScope`).
   * Passed for every stage (`extension.ts`'s `toApplyDeps`); absent only in
   * tests that do not exercise team scoping.
   */
  entry?: Pick<ResolvedRepoEntry, "alias" | "team" | "repoPath" | "branchPattern" | "pr">;
  /**
   * Linear user id to assign a block that needs a human (SPEC §9 Case B) —
   * puts it in the operator's own "My Issues" view. `null`/absent skips
   * assignee-based routing; the `foreman:blocked` label and comment still
   * land either way.
   */
  operatorUserId?: string | null;
}


/**
 * Clears the visible half of the lock (the assignee); `assigneeId` sets the
 * final owner in the same mutation (`null` clears it, the default). Then
 * releases the marker half `checkLockFree` actually reads: symmetric with
 * `claimLock` (enforce/task-guard.ts). Without posting a `released: true`
 * marker here, the next stage on this issue is refused until the lock's
 * full TTL expires.
 */
async function releaseLock(deps: ApplyDeps, issue: Issue, assigneeId: string | null = null): Promise<void> {
  await deps.linear.updateIssue(issue.id, { assigneeId });
  const viewerId = await deps.linear.viewerId().catch(() => null);
  const withComments = await deps.linear.issue(issue.id, { includeComments: true });
  if (!withComments) return;
  const held = readLockComment(withComments.comments, viewerId)?.data ?? null;
  if (!held || held.released) return;
  await deps.linear.createComment({
    issueId: issue.id,
    body: renderLockComment({ ...held, released: true, releasedAt: deps.now().toISOString() }),
  });
}

async function moveToState(deps: ApplyDeps, issue: Issue, stateKey: Parameters<typeof resolveState>[0]): Promise<void> {
  const states = await deps.linear.workflowStates(issue.team.id);
  const target = resolveState(stateKey, states);
  await deps.linear.updateIssue(issue.id, { stateId: target.id });
}

/**
 * Linear drops an API-created issue into the team's default state, which on a
 * triage-enabled team is `Triage` - the shared inbox `foreman plan`'s
 * `triage` rule consumes (§7.1). Every issue the extension creates is
 * already classified, so it has to name Backlog explicitly (§7.2 sub-issues,
 * §7.3 `discoveredWork`, §7.6 plan), or agent-authored work re-enters intake
 * as if a human had filed it.
 */
async function backlogStateId(deps: ApplyDeps, teamId: string): Promise<string> {
  const states = await deps.linear.workflowStates(teamId);
  return resolveState("backlog", states).id;
}

/** Per-apply memoization for the workspace/project label lists app resolution reads. */
interface AppLabelCache {
  issueLabels: Promise<IssueLabel[]> | null;
  projectLabels: Promise<IssueLabel[]> | null;
}

function newAppLabelCache(): AppLabelCache {
  return { issueLabels: null, projectLabels: null };
}

/**
 * Resolves `app:<name>`'s issue-label id by lookup only, memoized per apply
 * call — an app name is agent-supplied, so it is never created here, only
 * looked up. A name absent from the workspace set is the caller's problem
 * to report.
 */
async function resolveAppLabelId(deps: ApplyDeps, cache: AppLabelCache, appName: string): Promise<LinearId | null> {
  cache.issueLabels ??= deps.linear.labels();
  const labels = await cache.issueLabels;
  return labels.find((label) => label.name === appLabelId(appName))?.id ?? null;
}

/** Resolves `app:<name>`'s project-label id the same lookup-only way. */
async function resolveAppProjectLabelId(deps: ApplyDeps, cache: AppLabelCache, appName: string): Promise<LinearId | null> {
  cache.projectLabels ??= deps.linear.projectLabels();
  const labels = await cache.projectLabels;
  return labels.find((label) => label.name === appLabelId(appName))?.id ?? null;
}

/**
 * One triage item: `backlog` moves the issue into a project and Backlog
 * with priority/description/estimate set and its `blockedBy` relations
 * wired; `new-project` reuses an existing same-named project on the repo's
 * team when one exists, otherwise creates one, before doing the same;
 * `cancel` and `duplicate` leave the issue in Triage, move it to Needs
 * Input with a `block` marker recording the operator decision needed, and
 * (for `duplicate`) wire the native `duplicate` relation. Throws on any
 * failure — the caller isolates one item's failure from the rest of the
 * batch. An unresolvable `app` name is not such a failure: it is appended
 * to `problems` and the rest of the item still applies.
 */
async function applyTriageItem(
  deps: ApplyDeps,
  item: TriageItem,
  created: CreatedEntity[],
  problems: string[],
  cache: AppLabelCache,
): Promise<void> {
  const issue = await deps.linear.issue(item.issueId);
  if (!issue) throw new Error(`unknown issue "${item.issueId}"`);

  // The dispatch is scoped to one repo entry, and `linear.issue()` is not
  // team-scoped: without this, an injected item rewrites any issue in the
  // workspace. Thrown here, so `applyTriage` records it per item.
  if (deps.entry) {
    const verdict = issueScope(deps.entry, issue);
    if (!verdict.inScope) throw new Error(verdict.message ?? `${item.issueId} is out of scope`);
  }

  if (item.destination === "backlog" || item.destination === "new-project") {
    let projectId = item.destinationProjectId;
    let teamProjects: { id: string; name: string }[] | null = null;
    if (item.destination === "new-project") {
      if (!item.newProject) throw new Error(`applyTriage: ${issue.identifier} is "new-project" with no newProject.`);
      const newProject = item.newProject;
      // Idempotent: no durable dedupe marker survives a redelivered batch
      // any more (SPEC §17.7), so a second apply must reuse the project it
      // already created rather than creating a sibling with the same name.
      teamProjects = await deps.linear.projects(issue.team.key);
      const existing = teamProjects.find(
        (candidate) => candidate.name.trim().toLowerCase() === newProject.name.trim().toLowerCase(),
      );
      let project = existing;
      if (!project) {
        const labelIds: LinearId[] = [];
        if (newProject.app !== null) {
          const labelId = await resolveAppProjectLabelId(deps, cache, newProject.app);
          if (labelId) {
            labelIds.push(labelId);
          } else {
            problems.push(`${issue.identifier}: unknown app "${newProject.app}"; created project without an app label`);
          }
        }
        project = await deps.linear.createProject({
          name: newProject.name,
          teamIds: [issue.team.id],
          description: newProject.description,
          ...(labelIds.length > 0 ? { labelIds } : {}),
        });
        const status = await deps.linear.projectStatus(project.id);
        if (status?.type !== "backlog") await deps.linear.updateProjectStatus({ projectId: project.id, type: "backlog" });
        created.push({ kind: "project", id: project.id, identifier: null, title: project.name, url: null });
      }
      projectId = project.id;
    }
    if (!projectId) throw new Error(`applyTriage: ${issue.identifier} is "backlog" with no destinationProjectId.`);

    if (deps.entry && item.destination === "backlog") {
      const siblings = teamProjects ?? (await deps.linear.projects(issue.team.key));
      if (!siblings.some((candidate) => candidate.id === projectId)) {
        throw new Error(`${issue.identifier}: destinationProjectId ${projectId} is not a project on team ${issue.team.key}`);
      }
    }

    const typeLabel = await deps.linear.ensureWorkspaceLabel(item.type, { color: TYPE_LABEL_COLOR[item.type as TypeLabel] });
    const addedLabelIds = [typeLabel.id];
    if (item.app !== null) {
      const appId = await resolveAppLabelId(deps, cache, item.app);
      if (appId) {
        addedLabelIds.push(appId);
      } else {
        problems.push(`${issue.identifier}: unknown app "${item.app}"; applied no app label`);
      }
    }
    await deps.linear.updateIssue(issue.id, {
      priority: item.proposedPriority,
      description: item.draftDescription ?? undefined,
      estimate: item.proposedEstimate ?? undefined,
      projectId,
      addedLabelIds,
    });
    await moveToState(deps, issue, "backlog");

    // Otherwise read and discarded: the operator's only view onto why this
    // landed where it did (SPEC §7.1).
    const notes = [`Foreman triage: ${item.severityReasoning}`];
    if (item.missingInfo.length > 0) {
      notes.push("", "Missing before this is refinable:", ...item.missingInfo.map((line) => `- ${line}`));
    }
    await deps.linear.createComment({ issueId: issue.id, body: sanitizeAgentText(notes.join("\n")) });

    for (const blockerId of item.proposedBlockedBy) {
      const blocker = await deps.linear.issue(blockerId);
      if (!blocker) continue;
      if (deps.entry) {
        const verdict = issueScope(deps.entry, blocker);
        if (!verdict.inScope) {
          problems.push(`${issue.identifier}: blocker ${blockerId} is out of scope; no relation created`);
          continue;
        }
      }
      const alreadyRelated = issue.relations.some(
        (relation) =>
          relation.type === "blocks" &&
          relation.direction === "incoming" &&
          relation.other.id === blocker.id,
      );
      if (!alreadyRelated) {
        await deps.linear.createRelation({ issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
      }
    }
    return;
  }

  // cancel | duplicate: stays in Triage, parked for an operator decision.
  if (item.destination === "duplicate") {
    if (!item.duplicateOf) throw new Error(`applyTriage: ${issue.identifier} is "duplicate" with no duplicateOf.`);
    const original = await deps.linear.issue(item.duplicateOf);
    if (original) {
      const outOfScope = deps.entry ? !issueScope(deps.entry, original).inScope : false;
      if (outOfScope) {
        problems.push(`${issue.identifier}: blocker ${item.duplicateOf} is out of scope; no relation created`);
      } else {
        const alreadyRelated = issue.relations.some(
          (relation) =>
            relation.type === "duplicate" &&
            relation.direction === "outgoing" &&
            relation.other.id === original.id,
        );
        if (!alreadyRelated) {
          await deps.linear.createRelation({ issueId: issue.id, relatedIssueId: original.id, type: "duplicate" });
        }
      }
    }
  }
  const block: BlockRecord = {
    blocked: true,
    type: "needs-decision",
    whatIWasDoing: `Triaging ${issue.identifier}.`,
    whatINeed: item.destination === "duplicate"
      ? `Confirm ${issue.identifier} duplicates ${item.duplicateOf}: ${item.severityReasoning}`
      : `Confirm ${issue.identifier} should be canceled: ${item.severityReasoning}`,
    options: [
      { label: item.destination, tradeoff: item.severityReasoning },
      { label: "keep", tradeoff: "Leave the issue open in Triage." },
    ],
    recommendation: item.destination,
    stateLeftBehind: { worktree: null, branch: null, pushed: false, commits: [], notes: "" },
    costOfWrongGuess: "Applying a cancel/duplicate disposition without confirmation can silently drop real work.",
    blockedByIssues: [],
  };
  await moveToState(deps, issue, "needsInput");
  if (deps.operatorUserId) {
    await deps.linear.updateIssue(issue.id, { assigneeId: deps.operatorUserId });
  }
  const body = encodeMarker(MARKER_KIND.block, block, renderBlockComment(block));
  await deps.linear.createComment({ issueId: issue.id, body });
}

/**
 * Triage applies directly (no proposal/approval step). Each item is applied
 * in isolation: `deps.linear.issue()` throws `LinearApiError: Entity not
 * found` for a hallucinated id rather than returning null, so a per-item
 * try/catch — not an `if (!issue)` guard — is what actually keeps one bad
 * item from aborting the rest of the batch (SPEC §7.1, mirroring
 * `applyRoadmap`'s per-project isolation).
 */
async function applyTriage(deps: ApplyDeps, result: TriageResult, notify?: Notify): Promise<AppliedFacts> {
  const created: CreatedEntity[] = [];
  const failures: string[] = [];
  const notices: string[] = [];
  const cache = newAppLabelCache();
  for (const item of result.items) {
    try {
      await applyTriageItem(deps, item, created, notices, cache);
    } catch (error) {
      failures.push(`${item.issueId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    notify?.(`Foreman could not triage ${failures.length} item(s): ${failures.join("; ")}`, "error");
  }
  if (notices.length > 0) {
    notify?.(`Foreman triage: ${notices.join("; ")}`, "warn");
  }
  return {
    subject: null,
    summary: `triaged ${result.items.length - failures.length} of ${result.items.length} issue(s)`,
    created,
    movedTo: null,
  };
}

/** SPEC §7.2: description, estimate, sub-issues, spike (with its native `blocks` relation), move to Todo when ready. */
async function applyRefine(deps: ApplyDeps, result: RefineResult): Promise<AppliedFacts> {
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


  await deps.linear.updateIssue(issue.id, mutation);

  const needsBacklog = result.subIssues.length > 0 || result.spikeCreated !== null;
  const backlog = needsBacklog ? await backlogStateId(deps, issue.team.id) : null;

  // A retry after a mid-sequence failure re-runs this loop from the top; the
  // dispatch-applied marker is only written once the whole sequence lands, so
  // an existing child with this title is a completed step, not a duplicate
  // to create again.
  const existingChildTitles = new Set(issue.children.map((child) => child.title));
  const created: CreatedEntity[] = [];
  for (const subIssue of result.subIssues) {
    const subIssueTitle = stripControlChars(subIssue.title);
    if (existingChildTitles.has(subIssueTitle)) continue;
    const subDescription = renderIssueDescription({
      context: subIssue.description,
      acceptanceCriteria: subIssue.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: [],
    });
    const subTypeLabel = await deps.linear.ensureWorkspaceLabel(subIssue.type, { color: TYPE_LABEL_COLOR[subIssue.type as TypeLabel] });
    const child = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: subIssueTitle,
      description: subDescription,
      estimate: subIssue.estimate,
      parentId: issue.id,
      projectId: issue.project?.id,
      labelIds: [subTypeLabel.id],
      stateId: backlog ?? undefined,
    });
    created.push(createdIssue(child));
  }

  if (result.spikeCreated) {
    const spikeTitle = stripControlChars(result.spikeCreated.title);
    // The spike is created as a sibling with a `blocks` relation, not a
    // child, so the retry guard checks the parent's existing relations
    // instead of `issue.children`.
    const existingSpike = issue.relations.some(
      (relation) => relation.type === "blocks" && relation.other.title === spikeTitle,
    );
    if (!existingSpike) {
      const spikeBody = sanitizeAgentText(renderSpikeIssue(result.spikeCreated, { identifier: issue.identifier }));
      const spikeTypeLabel = await deps.linear.ensureWorkspaceLabel(TYPE_LABEL.spike, { color: TYPE_LABEL_COLOR[TYPE_LABEL.spike] });
      const spike = await deps.linear.createIssue({
        teamId: issue.team.id,
        title: spikeTitle,
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
      created.push(createdIssue(spike));
    }
  }

  if (result.readyForImplementation) await moveToState(deps, issue, "ready");
  await releaseLock(deps, issue);
  return {
    subject: issue.identifier,
    summary: `refined ${issue.identifier} (estimate ${result.estimate}, ` +
      `${result.readyForImplementation ? "ready" : "not ready"})`,
    created,
    movedTo: result.readyForImplementation ? "ready" : null,
  };
}

/** SPEC §7.3: move to In Review, file `discoveredWork` as new Backlog issues with native relations, comment the result, release the lock. */
async function applyImplement(deps: ApplyDeps, result: ImplementResult): Promise<AppliedFacts> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ImplementResult references unknown issue ${result.issueId}.`);
  if (deps.entry?.pr.required && result.prUrl.trim() === "") {
    throw new Error(`${issue.identifier}: pr.required is true but the implement result carries no prUrl`);
  }

  const backlog = result.discoveredWork.length > 0 ? await backlogStateId(deps, issue.team.id) : null;

  const createdEntities: CreatedEntity[] = [];
  for (const discovered of result.discoveredWork) {
    const discoveredTypeLabel = await deps.linear.ensureWorkspaceLabel(discovered.type, { color: TYPE_LABEL_COLOR[discovered.type as TypeLabel] });
    const created = await deps.linear.createIssue({
      teamId: issue.team.id,
      title: stripControlChars(discovered.title),
      description: sanitizeAgentText(discovered.description),
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
    createdEntities.push(createdIssue(created));
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
  return {
    subject: issue.identifier,
    summary: `implemented ${issue.identifier} on ${result.branch}` +
      (result.prUrl.length > 0 ? ` (${result.prUrl})` : " (no PR)"),
    created: createdEntities,
    movedTo: "inReview",
  };
}

/**
 * SPEC §7.6: creates each `proposedIssue` as a new Backlog issue under the
 * project. Nothing else — plan never claims `foreman:running`, so there is
 * no lock to release, and it never touches an existing issue's state. An
 * unresolvable `app` name is not fatal: it is reported and the issue still
 * applies without an app label, mirroring `applyTriageItem`.
 */
async function applyPlan(deps: ApplyDeps, result: PlanResult, notify?: Notify): Promise<AppliedFacts> {
  const project = await deps.linear.project(result.projectId);
  if (!project) throw new Error(`PlanResult references unknown project ${result.projectId}.`);
  if (deps.entry) {
    const siblings = await deps.linear.projects(deps.entry.team);
    if (!siblings.some((candidate) => candidate.id === project.id)) {
      throw new Error(`plan result targets project ${project.id}, which is not on team ${deps.entry.team}`);
    }
  }
  if (result.proposedIssues.length === 0) {
    return { subject: project.name, summary: `planned "${project.name}": no issues proposed`, created: [], movedTo: null };
  }

  const teamRef = await resolveTeamRef(deps, "plan");
  const cache = newAppLabelCache();
  const problems: string[] = [];

  const backlog = await backlogStateId(deps, teamRef.id);

  // Pass one: create every issue first and record `key -> created Issue`, so
  // pass two can wire a `blockedBy` reference to a sibling created later in
  // `proposedIssues` — array order is not dependency order.
  const createdByKey = new Map<string, Issue>();
  for (const proposed of result.proposedIssues) {
    const description = renderIssueDescription({
      context: proposed.description,
      acceptanceCriteria: proposed.acceptanceCriteria,
      affectedAreas: [],
      outOfScope: result.outOfScope,
    });
    const typeLabel = await deps.linear.ensureWorkspaceLabel(proposed.type, { color: TYPE_LABEL_COLOR[proposed.type as TypeLabel] });
    const labelIds = [typeLabel.id];
    if (proposed.app !== null) {
      const appId = await resolveAppLabelId(deps, cache, proposed.app);
      if (appId) {
        labelIds.push(appId);
      } else {
        problems.push(`${proposed.key}: unknown app "${proposed.app}"; applied no app label`);
      }
    }
    const created = await deps.linear.createIssue({
      teamId: teamRef.id,
      title: stripControlChars(proposed.title),
      description,
      priority: proposed.proposedPriority,
      estimate: proposed.proposedEstimate ?? undefined,
      projectId: result.projectId,
      labelIds,
      stateId: backlog,
    });
    createdByKey.set(proposed.key, created);
  }

  // Pass two: turn each `blockedBy` key into a native `blocks` relation. The
  // graph lives here, as relations, rather than as labels or prose in the
  // description, because the implement gate (SPEC dependency gating) reads
  // native relations only — a dependency that isn't a relation gates nothing.
  for (const proposed of result.proposedIssues) {
    const blocked = createdByKey.get(proposed.key);
    if (!blocked) throw new Error(`applyPlan: proposal key "${proposed.key}" was not created.`);
    for (const blockerKey of proposed.blockedBy) {
      const blocker = createdByKey.get(blockerKey);
      if (!blocker) {
        throw new Error(`applyPlan: proposal "${proposed.key}" blockedBy unknown key "${blockerKey}".`);
      }
      // Linear stores "A blocks B" as `{ issueId: A, relatedIssueId: B }` —
      // the same orientation as `applyImplement`'s discovered-work relations
      // and `applyRefine`'s spike case, not the inverse.
      await deps.linear.createRelation({ issueId: blocker.id, relatedIssueId: blocked.id, type: "blocks" });
    }
  }

  await deps.linear.updateProjectStatus({ projectId: result.projectId, type: "planned" });
  if (problems.length > 0) {
    notify?.(`Foreman plan: ${problems.join("; ")}`, "warn");
  }
  return {
    subject: project.name,
    summary: `planned "${project.name}": ${result.proposedIssues.length} issue(s)` +
      (result.fullyPlanned ? "" : ", partially planned"),
    created: [...createdByKey.values()].map(createdIssue),
    movedTo: null,
  };
}

/**
 * Mirrors `result.verdict` onto the PR itself as a real GitHub review (SPEC
 * §7.4), when the repo entry and PR are both resolvable. Best-effort: the
 * Linear-side comment above is the actual completion signal and the merge
 * gate's source of truth (`build.ts`'s `latestReview` check reads the
 * Linear marker, not GitHub's review state), so a repo with no PR
 * (direct-branch mode), no `deps.entry`, or an unreachable GitHub API must
 * never fail the whole apply — it only forgoes the GitHub-side mirror and
 * notifies.
 */
async function submitGitHubReview(deps: ApplyDeps, issue: Issue, result: ReviewResult, notify?: Notify): Promise<void> {
  if (!deps.entry?.repoPath || !deps.entry.branchPattern) return;
  try {
    const branch = branchNameFor(deps.entry.branchPattern, issue, deps.entry.repoPath);
    const pr = await deps.github.prForBranch(deps.entry.repoPath, branch);
    if (!pr) return;
    const event: ReviewEvent =
      result.verdict === "approve" ? "APPROVE" : result.verdict === "request-changes" ? "REQUEST_CHANGES" : "COMMENT";
    await deps.github.createReview(deps.entry.repoPath, pr.number, { event, body: renderReviewComment(result) });
  } catch (error) {
    notify?.(
      `Couldn't submit the GitHub review for ${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
      "warn",
    );
  }
}

/**
 * SPEC §13.4/§19: always comment the rendering and write a `review` marker
 * so `hasReviewForHead` detects completion. A `blocking` finding routes the
 * issue back to Ready for the fix cycle; a clean result leaves merging
 * entirely to the operator — no auto-merge, ever. The lock is released
 * either way: review is a terminal result.
 */
async function applyReview(deps: ApplyDeps, result: ReviewResult, notify?: Notify): Promise<AppliedFacts> {
  const issue = await deps.linear.issue(result.issueId);
  if (!issue) throw new Error(`ReviewResult references unknown issue ${result.issueId}.`);

  const human = renderReviewComment(result);
  const body = encodeMarker(MARKER_KIND.review, result, human);
  await deps.linear.createComment({ issueId: issue.id, body });
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  if (blocking.length > 0) await moveToState(deps, issue, "ready");
  await submitGitHubReview(deps, issue, result, notify);
  await releaseLock(deps, issue);
  return {
    subject: issue.identifier,
    summary: `reviewed ${issue.identifier}: ${result.verdict}, ${blocking.length} blocking finding(s)`,
    created: [],
    movedTo: blocking.length > 0 ? "ready" : null,
  };
}

/** SPEC §9 Case A: a `dependency` block creates/verifies the relation, no state carried, back to Ready. An unresolvable blocker identifier is not silently dropped: it is routed like a human block (Case B) instead, so the issue does not loop forever waiting on an identifier that will never resolve. */
async function applyDependencyBlock(
  deps: ApplyDeps,
  issue: Issue,
  block: BlockRecord,
  agent: string,
  notify?: Notify,
): Promise<AppliedFacts> {
  const missing: string[] = [];
  for (const blockerId of block.blockedByIssues) {
    const blocker = await deps.linear.issue(blockerId);
    if (!blocker) {
      missing.push(blockerId);
      continue;
    }
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
  const body = sanitizeAgentText(renderBlockComment(block));
  await deps.linear.createComment({ issueId: issue.id, body });
  if (missing.length > 0) {
    notify?.(
      `${issue.identifier}: dependency block names unresolvable issue(s) ${missing.join(", ")}; routed to a human queue instead of Ready`,
      "warn",
    );
    const stateKey = IMPLEMENTATION_BLOCK_AGENTS[agent] ? "blocked" : "needsInput";
    await moveToState(deps, issue, stateKey);
    await releaseLock(deps, issue, deps.operatorUserId ?? null);
    return {
      subject: issue.identifier,
      summary: `blocked ${issue.identifier}: dependency on unresolvable issue(s) ${missing.join(", ")}`,
      created: [],
      movedTo: stateKey,
    };
  }
  await releaseLock(deps, issue);
  await moveToState(deps, issue, "ready");
  return { subject: issue.identifier, summary: `blocked ${issue.identifier}: ${block.type} — ${block.whatINeed}`, created: [], movedTo: "ready" };
}

/** Which agent produced a `BlockRecord` decides the human-interrupt queue it lands in: refine stalls before implementation starts, so it reads `Needs Input`; implement/review stall mid-flight, so they read `Blocked`. */
const IMPLEMENTATION_BLOCK_AGENTS: Record<string, true> = { "foreman-implement": true, "foreman-review": true };

/** SPEC §9 Case B: every other block type moves the issue to Needs Input or Blocked (by stage), comments, and assigns the operator while releasing the lock. */
async function applyHumanBlock(deps: ApplyDeps, issue: Issue, block: BlockRecord, agent: string): Promise<AppliedFacts> {
  const stateKey = IMPLEMENTATION_BLOCK_AGENTS[agent] ? "blocked" : "needsInput";
  await moveToState(deps, issue, stateKey);
  const body = encodeMarker(MARKER_KIND.block, block, renderBlockComment(block));
  await deps.linear.createComment({ issueId: issue.id, body });
  await releaseLock(deps, issue, deps.operatorUserId ?? null);
  return { subject: issue.identifier, summary: `blocked ${issue.identifier}: ${block.type} — ${block.whatINeed}`, created: [], movedTo: stateKey };
}

/** Routes a `BlockRecord` through SPEC §9 instead of the normal result path. `agent` picks the human-block queue (Needs Input vs Blocked). */
export async function applyBlock(deps: ApplyDeps, issueId: string, block: BlockRecord, agent: string, notify?: Notify): Promise<AppliedFacts> {
  const issue = await deps.linear.issue(issueId);
  if (!issue) throw new Error(`Block references unknown issue ${issueId}.`);

  if (block.type === "dependency") {
    return applyDependencyBlock(deps, issue, block, agent, notify);
  }
  return applyHumanBlock(deps, issue, block, agent);
}


/**
 * Resolves the team every new Linear entity has to carry. Shared by the two
 * appliers that create rather than update: `ProjectCreateInput` and
 * `IssueCreateInput` both require a team, and neither agent is told one —
 * the instance's registry entry is the authority (SPEC §3.11).
 */
async function resolveTeamRef(deps: ApplyDeps, forWhat: string): Promise<TeamRef> {
  if (!deps.entry) throw new Error(`${forWhat} requires deps.entry to resolve the team.`);
  const teams = await deps.linear.teams();
  const teamKey = await resolveTeamKey({ linear: { teams: async () => teams }, entryTeam: deps.entry.team });
  const teamRef = teams.find((candidate) => candidate.key === teamKey);
  if (!teamRef) throw new Error(`Team "${teamKey}" was not found while applying a ${forWhat} result.`);
  return teamRef;
}

/**
 * SPEC §7.7: creates every proposed project, wires its dependency edges, and
 * clamps any `startDate` that precedes a blocker's `targetDate`.
 *
 * `applyRoadmap` reports rather than throws, because a roadmap is a batch:
 * one unresolvable blocker must not discard the projects that did apply. So
 * the report is surfaced to the operator here — clamped dates as a warning,
 * per-entry failures as an error — and only a run that created nothing at
 * all is escalated to a throw, since that is indistinguishable from a failed
 * apply and should be visible as one.
 */
async function applyRoadmapResult(
  deps: ApplyDeps,
  result: RoadmapResult,
  notify?: Notify,
): Promise<AppliedFacts> {
  const teamRef = await resolveTeamRef(deps, "roadmap");
  const appNames = [...new Set(result.proposedProjects.map((entry) => entry.app).filter((app): app is string => app !== null))];
  const appLabelIds: Record<string, LinearId> = {};
  if (appNames.length > 0) {
    const projectLabels = await deps.linear.projectLabels();
    for (const name of appNames) {
      const label = projectLabels.find((candidate) => candidate.name === appLabelId(name));
      if (label) appLabelIds[name] = label.id;
    }
  }
  const report = await applyRoadmap(deps.linear, result, { teamId: teamRef.id, appLabelIds });

  for (const adjustment of report.dateAdjustments) {
    notify?.(
      `Foreman moved "${adjustment.key}" to ${adjustment.appliedStartDate} → ${adjustment.appliedTargetDate} ` +
        `(proposed ${adjustment.requestedStartDate} → ${adjustment.requestedTargetDate}): it cannot start before ` +
        `its last prerequisite ends on ${adjustment.forcedByTargetDate}.`,
      "warn",
    );
  }

  const facts: AppliedFacts = {
    subject: null,
    summary: `roadmap: created ${report.createdProjects.length} of ${result.proposedProjects.length} project(s)`,
    created: report.createdProjects.map((entry) => ({
      kind: "project" as const, id: entry.projectId, identifier: null, title: entry.name, url: null,
    })),
    movedTo: null,
  };

  if (report.problems.length === 0) return facts;
  const detail = report.problems.map((problem) => `${problem.key}: ${problem.error}`).join("; ");
  if (report.createdProjects.length === 0) {
    throw new Error(`No project in this roadmap could be created — ${detail}`);
  }
  notify?.(
    `Foreman applied ${report.createdProjects.length} of ${result.proposedProjects.length} proposed projects. ` +
      `Unresolved: ${detail}`,
    "error",
  );
  return facts;
}

/**
 * Dispatches one `AgentOutcome` to the matching applier. A blocked outcome
 * with no `issueId` (possible for `foreman-plan` and `foreman-roadmap`, which
 * operate on a project and an initiative rather than an issue) has nothing to
 * write to — Linear has no project-level `foreman:blocked` surface — so it is
 * a documented no-op; the block is still visible in the loop's own log and
 * `/foreman:status`.
 *
 * `notify` is optional because only the roadmap applier has a partial-success
 * report worth showing an operator mid-apply; every other stage either
 * succeeds outright or throws.
 */
export async function applyOutcome(deps: ApplyDeps, outcome: AgentOutcome, notify?: Notify): Promise<AppliedFacts> {
  if (outcome.kind === "blocked") {
    if (!outcome.issueId) {
      return { subject: null, summary: `dropped a block from ${outcome.agent}: no issue to write it to`, created: [], movedTo: null };
    }
    return applyBlock(deps, outcome.issueId, outcome.block, outcome.agent, notify);
  }
  if (outcome.agent === "foreman-triage") {
    return applyTriage(deps, outcome.result, notify);
  } else if (outcome.agent === "foreman-plan") {
    return applyPlan(deps, outcome.result, notify);
  } else if (outcome.agent === "foreman-roadmap") {
    return applyRoadmapResult(deps, outcome.result, notify);
  } else if (outcome.agent === "foreman-refine") {
    return applyRefine(deps, outcome.result);
  } else if (outcome.agent === "foreman-implement") {
    return applyImplement(deps, outcome.result);
  } else {
    return applyReview(deps, outcome.result, notify);
  }
}
