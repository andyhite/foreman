/**
 * The deterministic apply engine for a `RoadmapResult` (see
 * `schemas/roadmap.ts`) — the project-level mirror of `applyProposals`.
 *
 * `foreman-roadmap` proposes projects only; it never touches Linear itself
 * (SPEC §3.5 item 1, principle 9). This module is where those proposals
 * become real projects: created, dated, and wired with native `dependency`
 * relations, one entry at a time so a single bad entry never hides the rest
 * of the batch.
 */

import { latestTargetDate } from "../linear/project.ts";
import type { LinearWriter } from "../linear/api.ts";
import type { LinearId, Project, ProjectRef } from "../linear/types.ts";
import type { ProposedProject, RoadmapResult } from "../schemas/roadmap.ts";

/**
 * A `startDate`/`targetDate` pair the model proposed that collided with a
 * blocker's `targetDate` and had to move. Recorded rather than silently
 * corrected: the model's arithmetic is not the contract, but an operator
 * scanning the run log still needs to see every date it did not literally
 * get.
 */
export interface RoadmapDateAdjustment {
  key: string;
  requestedStartDate: string;
  requestedTargetDate: string;
  appliedStartDate: string;
  appliedTargetDate: string;
  /** The latest blocker `targetDate` that forced the shift. */
  forcedByTargetDate: string;
}

/** One `proposedProjects[]` entry that failed to fully apply. Isolated so it never hides the rest of the batch. */
export interface RoadmapProblem {
  key: string;
  error: string;
}

export interface CreatedRoadmapProject {
  key: string;
  projectId: LinearId;
  name: string;
}

export interface CreatedRoadmapRelation {
  /** The project that must finish first. */
  blockerProjectId: LinearId;
  /** The project it gates the start of. */
  blockedProjectId: LinearId;
}

export interface RoadmapApplyResult {
  createdProjects: CreatedRoadmapProject[];
  relationsCreated: CreatedRoadmapRelation[];
  dateAdjustments: RoadmapDateAdjustment[];
  problems: RoadmapProblem[];
}

/** Parses a `TimelessDate` (`YYYY-MM-DD`) as a UTC midnight instant, so day arithmetic never drifts across a local timezone boundary. */
function parseTimelessDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatTimelessDate(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}

function addDays(date: string, days: number): string {
  const shifted = new Date(parseTimelessDate(date).getTime() + days * 86_400_000);
  return formatTimelessDate(shifted);
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseTimelessDate(end).getTime() - parseTimelessDate(start).getTime()) / 86_400_000);
}

/**
 * Topological order over `proposedProjects` by `blockedBy` (sibling keys
 * only — `blockedByExisting` points outside this result and carries no
 * ordering ambiguity). `parse.ts` already ran `validateDependencyKeys`
 * before this function is ever reached, so the graph is a DAG with no
 * dangling refs; this is Kahn's algorithm, defensive rather than trusting,
 * so a caller that skips validation degrades to input order instead of an
 * infinite loop.
 */
function topoOrder(entries: readonly ProposedProject[]): string[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const indegree = new Map<string, number>();
  for (const entry of entries) indegree.set(entry.key, 0);
  for (const entry of entries) {
    for (const blockerKey of entry.blockedBy) {
      if (byKey.has(blockerKey)) indegree.set(entry.key, (indegree.get(entry.key) ?? 0) + 1);
    }
  }
  const dependents = new Map<string, string[]>();
  for (const entry of entries) {
    for (const blockerKey of entry.blockedBy) {
      if (!byKey.has(blockerKey)) continue;
      const list = dependents.get(blockerKey) ?? [];
      list.push(entry.key);
      dependents.set(blockerKey, list);
    }
  }

  const queue: string[] = entries.filter((entry) => (indegree.get(entry.key) ?? 0) === 0).map((entry) => entry.key);
  const order: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || visited.has(key)) continue;
    visited.add(key);
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  // Any entry never reached (a cycle `validateDependencyKeys` should have
  // already rejected) still needs a slot so it gets created, just without
  // the date propagation a genuine DAG would give it.
  for (const entry of entries) {
    if (!visited.has(entry.key)) order.push(entry.key);
  }
  return order;
}

/**
 * Applies one `RoadmapResult`: creates every proposed project (optionally
 * carrying one `app:` project label), clamps dates against resolved
 * blockers, and wires the `dependency` relations last so a forward
 * reference (an entry that lists a sibling created later in the batch)
 * still resolves.
 *
 * Not atomic — each entry's create/relate sequence is isolated in its own
 * try/catch, exactly as `applyProposal`/`runApplyPass` isolate a triage
 * candidate, so one bad entry never hides the rest of the roadmap.
 */
export async function applyRoadmap(
  linear: LinearWriter,
  result: RoadmapResult,
  input: { teamId: LinearId; appLabelIds: Record<string, LinearId> },
): Promise<RoadmapApplyResult> {
  const problems: RoadmapProblem[] = [];
  const dateAdjustments: RoadmapDateAdjustment[] = [];
  const createdProjects: CreatedRoadmapProject[] = [];
  const relationsCreated: CreatedRoadmapRelation[] = [];

  const byKey = new Map(result.proposedProjects.map((entry) => [entry.key, entry]));

  // `blockedByExisting` ids are resolved once per id, not once per entry —
  // several entries can share a blocker. An id that fails to resolve is a
  // problem on that entry only; it must never abort entries that do not
  // reference it.
  const existingCache = new Map<string, Project | null>();
  async function resolveExisting(id: string): Promise<Project | null> {
    const cached = existingCache.get(id);
    if (cached !== undefined) return cached;
    const project = await linear.project(id);
    existingCache.set(id, project);
    return project;
  }

  // Pass 1: compute each entry's effective dates, in dependency order so a
  // shift on one entry propagates to whatever it in turn blocks. Clamping
  // (never rejecting) is deliberate: the sequence `blockedBy` encodes is
  // the real contract (SPEC §17.5); the model's `startDate` arithmetic
  // reconciling that sequence is best-effort and is expected to be wrong
  // sometimes. Rejecting the whole entry over a date the extension can
  // trivially repair would throw away a decomposition that is otherwise
  // sound. The adjustment is recorded, not silently applied, so an operator
  // scanning the run log can see every date that was not what the model
  // asked for.
  const computedDates = new Map<string, { startDate: string; targetDate: string }>();
  for (const key of topoOrder(result.proposedProjects)) {
    const entry = byKey.get(key);
    if (!entry) continue;

    const blockerRefs: ProjectRef[] = [];
    for (const blockerKey of entry.blockedBy) {
      const computed = computedDates.get(blockerKey);
      if (computed) blockerRefs.push({ id: blockerKey, name: blockerKey, targetDate: computed.targetDate });
    }
    for (const existingId of entry.blockedByExisting) {
      const project = await resolveExisting(existingId);
      if (!project) {
        problems.push({ key, error: `blockedByExisting project "${existingId}" could not be resolved` });
        continue;
      }
      blockerRefs.push({ id: project.id, name: project.name, targetDate: project.targetDate });
    }

    const latest = latestTargetDate(blockerRefs);
    let startDate = entry.startDate;
    let targetDate = entry.targetDate;
    if (latest !== null && startDate <= latest) {
      const durationDays = daysBetween(entry.startDate, entry.targetDate);
      const shiftedStart = addDays(latest, 1);
      const shiftedTarget = addDays(shiftedStart, durationDays);
      dateAdjustments.push({
        key,
        requestedStartDate: entry.startDate,
        requestedTargetDate: entry.targetDate,
        appliedStartDate: shiftedStart,
        appliedTargetDate: shiftedTarget,
        forcedByTargetDate: latest,
      });
      startDate = shiftedStart;
      targetDate = shiftedTarget;
    }
    computedDates.set(key, { startDate, targetDate });
  }

  // Pass 2: create each project. A project may optionally carry one `app:`
  // project label, resolved by the caller into `input.appLabelIds`; an
  // `app` naming a key absent from that map is reported as a problem on
  // this entry, and the project is still created without the label.
  const createdIdByKey = new Map<string, LinearId>();
  for (const entry of result.proposedProjects) {
    const dates = computedDates.get(entry.key) ?? { startDate: entry.startDate, targetDate: entry.targetDate };
    const labelIds: LinearId[] = [];
    if (entry.app !== null) {
      const labelId = input.appLabelIds[entry.app];
      if (labelId) {
        labelIds.push(labelId);
      } else {
        problems.push({
          key: entry.key,
          error: `project "${entry.name}" names unknown app "${entry.app}"; created without an app label`,
        });
      }
    }
    let project: { id: LinearId; name: string };
    try {
      project = await linear.createProject({
        name: entry.name,
        teamIds: [input.teamId],
        description: entry.description,
        content: entry.brief,
        startDate: dates.startDate,
        targetDate: dates.targetDate,
        ...(labelIds.length > 0 ? { labelIds } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push({ key: entry.key, error: `failed to create project: ${reason}` });
      continue;
    }
    createdProjects.push({ key: entry.key, projectId: project.id, name: project.name });
    createdIdByKey.set(entry.key, project.id);
  }

  // Pass 3: relations after every create, so an entry that names a sibling
  // created later in the batch still resolves. `blocker` finishing gates
  // `blocked` starting: `end` on the blocker anchors `start` on the blocked
  // project (SPEC §4.10a, `linear/project.ts`).
  for (const entry of result.proposedProjects) {
    const blockedProjectId = createdIdByKey.get(entry.key);
    if (!blockedProjectId) continue; // already reported in pass 2

    for (const blockerKey of entry.blockedBy) {
      const blockerProjectId = createdIdByKey.get(blockerKey);
      if (!blockerProjectId) {
        problems.push({
          key: entry.key,
          error: `blocker "${blockerKey}" was not created; dependency edge skipped`,
        });
        continue;
      }
      try {
        await linear.createProjectRelation({
          projectId: blockerProjectId,
          relatedProjectId: blockedProjectId,
          type: "dependency",
          anchorType: "end",
          relatedAnchorType: "start",
        });
        relationsCreated.push({ blockerProjectId, blockedProjectId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        problems.push({ key: entry.key, error: `failed to create dependency edge from "${blockerKey}": ${reason}` });
      }
    }

    for (const existingId of entry.blockedByExisting) {
      const blockerProject = existingCache.get(existingId);
      if (!blockerProject) continue; // already reported in pass 1
      try {
        await linear.createProjectRelation({
          projectId: blockerProject.id,
          relatedProjectId: blockedProjectId,
          type: "dependency",
          anchorType: "end",
          relatedAnchorType: "start",
        });
        relationsCreated.push({ blockerProjectId: blockerProject.id, blockedProjectId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        problems.push({
          key: entry.key,
          error: `failed to create dependency edge from existing project "${existingId}": ${reason}`,
        });
      }
    }
  }

  return { createdProjects, relationsCreated, dateAdjustments, problems };
}
