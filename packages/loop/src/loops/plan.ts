/**
 * `foreman plan` — triage, plan, refine (simplification plan Phase 4).
 */

import {
  all,
  any,
  DISPATCH_COMMAND,
  incompleteBlockers,
  incompleteProjectBlockers,
  implementationGate,
  inInitiatives,
  INBOX_FILTER,
  inStateType,
  isTerminalProjectStatus,
  type Issue,
  MAINTENANCE_PROJECT_NAME,
  notInPausedProject,
  notInTerminalProject,
  prioritized,
  type ProjectRef,
  type ProjectRelation,
  unlabeled,
} from "@foreman/core";
import { byPriorityThenAge, type Candidate, type Loop, type Rule } from "../engine.ts";

interface ProjectEntry {
  project: ProjectRef;
  cwd: string;
  relations: ProjectRelation[];
}

export interface PlanSnapshot {
  inbox: Issue[];
  backlog: Issue[];
  unrefinedTodo: Issue[];
  projects: ProjectEntry[];
  cwd: string;
  triageBatch: number;
  initiativeIds: readonly string[];
}

const triageRule: Rule<PlanSnapshot> = {
  name: "triage",
  select(snapshot) {
    if (snapshot.inbox.length === 0) return [];
    const batch = snapshot.inbox.slice(0, snapshot.triageBatch);
    const identifiers = batch.map((issue) => issue.identifier);
    return [
      {
        // Keyed on the whole batch, not just its head: keying on `identifiers[0]` alone
        // changes identity the instant the head issue leaves Triage, resetting the
        // failure counter and, at `concurrency.plan > 1`, admitting a second agent onto
        // the same issue.
        key: `triage:${[...identifiers].sort().join(",")}`,
        agent: "foreman-triage",
        command: DISPATCH_COMMAND.triage,
        subject: `--initiatives ${snapshot.initiativeIds.join(",")} ${identifiers.join(" ")}`,
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
    const eligible = [...snapshot.backlog, ...snapshot.unrefinedTodo]
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
    // A Triage issue with no project at all cannot match `inInitiatives`, whose
    // `{ project: { initiatives: { some: … } } }` shape requires a project to exist —
    // so the team-wide inbox needs the `{ project: { null: true } }` escape hatch too
    // (measured against the live API, `docs/VERIFIED.md`), or the inbox is permanently
    // empty and triage never fires.
    const inbox = await ctx.linear.issues({
      filter: all(
        any(inInitiatives(ctx.entry.initiativeIds), { project: { null: true } }),
        INBOX_FILTER,
        unlabeled(),
      ),
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

    // The legacy funnel, re-expressed label-free: a pre-existing Todo issue that fails
    // the implementation gate (no acceptance criteria, no estimate, …) is exactly what
    // the deleted `legacy` label used to mark. `refineRule` only reads `backlog`
    // (inStateType "backlog"), so without this a Todo issue in that shape is stranded —
    // refine cannot see it and implement drops it on the gate.
    const unrefinedTodo = (
      await ctx.linear.issues({
        filter: all(
          inInitiatives(ctx.entry.initiativeIds),
          inStateType("unstarted"),
          unlabeled(),
          prioritized(),
          notInTerminalProject(),
          notInPausedProject(),
        ),
      })
    ).filter((issue) => !implementationGate(issue).ok);

    // One issue query for the whole scope, then in-memory membership: a project's
    // native `status` never advances on its own (that is `reconcile`'s job now, SPEC
    // §7.6a), so testing `status?.type !== "backlog"` re-plans a populated Backlog
    // project on every poll. The real predicate is "has zero issues yet".
    const scopeIssues = await ctx.linear.issues({ filter: inInitiatives(ctx.entry.initiativeIds) });
    const projectsWithIssues = new Set(
      scopeIssues.map((issue) => issue.project?.id).filter((id): id is string => id != null),
    );

    const projects: ProjectEntry[] = [];
    for (const initiativeId of ctx.entry.initiativeIds) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the small, fixed set of initiatives one repo entry binds.
      const initiativeProjects = await ctx.linear.initiativeProjects(initiativeId);
      for (const project of initiativeProjects) {
        if (project.name.trim().toLowerCase() === MAINTENANCE_PROJECT_NAME.toLowerCase()) continue;
        if (isTerminalProjectStatus(project.status)) continue;
        if (projectsWithIssues.has(project.id)) continue;
        // eslint-disable-next-line no-await-in-loop
        const relations = await ctx.linear.projectRelations(project.id);
        projects.push({ project, cwd: ctx.entry.repoPath, relations });
      }
    }

    return {
      inbox,
      backlog,
      unrefinedTodo,
      projects,
      cwd: ctx.entry.repoPath,
      triageBatch: ctx.config.loop.triageBatch,
      initiativeIds: ctx.entry.initiativeIds,
    };
  },
  rules: [triageRule, planRule, refineRule],
};
