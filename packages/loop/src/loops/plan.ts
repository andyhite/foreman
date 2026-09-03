/**
 * `foreman plan` — triage, plan, refine (simplification plan Phase 4).
 *
 * KNOWN GAP: the plan's `fetch` also wants Triage issues with no project at
 * all (the team-wide inbox), reachable only through a filter shape
 * (`{ project: { null: true } }`) this implementation has not verified
 * against the live Linear API. `inbox` here is the straightforward,
 * verified `all(inInitiatives(ids), INBOX_FILTER, unlabeled())` read; the
 * no-project fallback is not implemented. Flagged explicitly rather than
 * guessed at.
 */

import {
  all,
  DISPATCH_COMMAND,
  incompleteBlockers,
  incompleteProjectBlockers,
  inInitiatives,
  INBOX_FILTER,
  inStateType,
  type Issue,
  notInPausedProject,
  notInTerminalProject,
  prioritized,
  type ProjectRef,
  type ProjectRelation,
  priorityRank,
  unlabeled,
} from "@foreman/core";
import type { Candidate, Loop, Rule } from "../engine.ts";

function byPriorityThenAge(a: Issue, b: Issue): number {
  const rankDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (rankDiff !== 0) return rankDiff;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

interface ProjectEntry {
  project: ProjectRef;
  cwd: string;
  relations: ProjectRelation[];
}

export interface PlanSnapshot {
  inbox: Issue[];
  backlog: Issue[];
  projects: ProjectEntry[];
  cwd: string;
  triageBatch: number;
}

const triageRule: Rule<PlanSnapshot> = {
  name: "triage",
  select(snapshot) {
    if (snapshot.inbox.length === 0) return [];
    const batch = snapshot.inbox.slice(0, snapshot.triageBatch);
    const identifiers = batch.map((issue) => issue.identifier);
    return [
      {
        key: `triage:${identifiers[0]}`,
        agent: "foreman-triage",
        command: DISPATCH_COMMAND.triage,
        subject: identifiers.join(" "),
        cwd: snapshot.cwd,
        worktree: null,
        reason: `dispatch foreman-triage for ${identifiers.join(", ")}`,
      },
    ];
  },
};

const planRule: Rule<PlanSnapshot> = {
  name: "plan",
  select(snapshot) {
    const eligible = snapshot.projects.filter((entry) => incompleteProjectBlockers(entry.relations).length === 0);
    return eligible.map(
      (entry): Candidate => ({
        key: `project:${entry.project.id}`,
        agent: "foreman-plan",
        command: DISPATCH_COMMAND.plan,
        subject: entry.project.id,
        cwd: entry.cwd,
        worktree: null,
        reason: `dispatch foreman-plan for project ${entry.project.name}`,
      }),
    );
  },
};

const refineRule: Rule<PlanSnapshot> = {
  name: "refine",
  select(snapshot) {
    const eligible = snapshot.backlog
      .filter((issue) => issue.assignee === null && incompleteBlockers(issue).length === 0)
      .sort(byPriorityThenAge);
    return eligible.map(
      (issue): Candidate => ({
        key: `issue:${issue.identifier}`,
        agent: "foreman-refine",
        command: DISPATCH_COMMAND.refine,
        subject: issue.identifier,
        cwd: snapshot.cwd,
        worktree: null,
        reason: `dispatch foreman-refine for ${issue.identifier}`,
      }),
    );
  },
};

export const PLAN_LOOP: Loop<PlanSnapshot> = {
  name: "plan",
  concurrency: 1,
  async fetch(ctx) {
    const inbox = await ctx.linear.issues({
      filter: all(inInitiatives(ctx.entry.initiativeIds), INBOX_FILTER, unlabeled()),
    });

    const backlog = await ctx.linear.issues({
      filter: all(
        inInitiatives(ctx.entry.initiativeIds),
        inStateType("backlog"),
        unlabeled(),
        prioritized(),
        notInTerminalProject(),
        notInPausedProject(),
      ),
    });

    const projects: ProjectEntry[] = [];
    for (const initiativeId of ctx.entry.initiativeIds) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the small, fixed set of initiatives one repo entry binds.
      const initiativeProjects = await ctx.linear.initiativeProjects(initiativeId);
      for (const project of initiativeProjects) {
        if (project.status?.type !== "backlog") continue;
        // eslint-disable-next-line no-await-in-loop
        const relations = await ctx.linear.projectRelations(project.id);
        projects.push({ project, cwd: ctx.entry.repoPath, relations });
      }
    }

    return { inbox, backlog, projects, cwd: ctx.entry.repoPath, triageBatch: ctx.config.loop.triageBatch };
  },
  rules: [triageRule, planRule, refineRule],
};
