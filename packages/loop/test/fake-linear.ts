import type {
  Comment,
  CreateIssueInput,
  Initiative,
  InitiativeRef,
  Issue,
  IssueFilter,
  IssueLabel,
  IssueMutation,
  IssueQuery,
  IssueRelationType,
  LinearId,
  LinearWriter,
  Project,
  ProjectRef,
  ProjectRelation,
  ProjectStatus,
  ProjectStatusType,
  TeamRef,
  WorkflowState,
} from "@foreman/core";

/**
 * Evaluates the small subset of `IssueFilter` shapes `filters.ts` actually
 * produces — `and`/`or`, `state.name`/`state.type` (`eq`/`nin`),
 * `labels.some`/`labels.none` (matched against this fake's labels, which
 * carry a Linear-shaped `name`/`parentId` pair the same way `filter()` did
 * for the tests seeding them) — good enough to keep each invariant's
 * `select` seeing only the issues a real server-side filter would return.
 * `project.initiatives` is untested here and always matches.
 */
function matchesFilter(issue: Issue, filter: IssueFilter): boolean {
  const asRecord = filter as Record<string, unknown>;
  if (Array.isArray(asRecord.and)) return (asRecord.and as IssueFilter[]).every((sub) => matchesFilter(issue, sub));
  if (Array.isArray(asRecord.or)) return (asRecord.or as IssueFilter[]).some((sub) => matchesFilter(issue, sub));

  const state = asRecord.state as Record<string, Record<string, unknown>> | undefined;
  if (state?.name?.eq !== undefined && issue.state.name !== state.name.eq) return false;
  if (state?.type?.eq !== undefined && issue.state.type !== state.type.eq) return false;
  if (Array.isArray(state?.type?.nin) && (state.type.nin as string[]).includes(issue.state.type)) return false;

  const labels = asRecord.labels as { some?: Record<string, unknown>; none?: Record<string, unknown> } | undefined;
  if (labels?.some && !issue.labels.some((label) => labelMatches(label, labels.some!))) return false;
  if (labels?.none && issue.labels.some((label) => labelMatches(label, labels.none!))) return false;

  return true;
}

function labelMatches(label: IssueLabel, match: Record<string, unknown>): boolean {
  const nameEq = (match.name as { eq?: string } | undefined)?.eq;
  if (nameEq !== undefined && label.name !== nameEq) return false;
  const parentNameEq = (match.parent as { name?: { eq?: string } } | undefined)?.name?.eq;
  if (parentNameEq !== undefined && label.parentId !== parentNameEq) return false;
  return true;
}

/**
 * Minimal in-memory `LinearWriter` for `reconcile.test.ts`. `issues()`
 * evaluates `query.filter` via `matchesFilter` so each invariant's `select`
 * sees only the issues a real server-side filter would return; every
 * mutation re-runs the same filter on the next `select`, so a fix that
 * moves an issue out of scope is invisible to the invariants that follow.
 */
export class FakeLinear implements LinearWriter {
  issuesById = new Map<string, Issue>();
  updateCalls: Array<{ id: string; input: IssueMutation }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  workflowStatesList: WorkflowState[];

  constructor(issues: Issue[] = [], workflowStates?: WorkflowState[]) {
    for (const issue of issues) this.issuesById.set(issue.id, issue);
    this.workflowStatesList = workflowStates ?? [
      { id: "state-todo", name: "Todo", type: "unstarted", position: 2 },
      { id: "state-in-progress", name: "In Progress", type: "started", position: 3 },
      { id: "state-in-review", name: "In Review", type: "started", position: 4 },
      { id: "state-done", name: "Done", type: "completed", position: 5 },
    ];
  }

  async issue(id: string): Promise<Issue | null> {
    return this.issuesById.get(id) ?? [...this.issuesById.values()].find((issue) => issue.identifier === id) ?? null;
  }

  async issues(query: IssueQuery): Promise<Issue[]> {
    const all = [...this.issuesById.values()];
    return query.filter ? all.filter((issue) => matchesFilter(issue, query.filter!)) : all;
  }


  async comments(issueId: string): Promise<Comment[]> {
    return this.issuesById.get(issueId)?.comments ?? [];
  }

  async project(): Promise<Project | null> {
    return null;
  }

  async projectInitiatives(): Promise<InitiativeRef[]> {
    return [];
  }

  async projectInitiative(): Promise<InitiativeRef> {
    throw new Error("not implemented");
  }

  async initiative(id: string): Promise<Initiative | null> {
    return { id, name: "Initiative", documents: [] };
  }

  async initiatives(): Promise<InitiativeRef[]> {
    return [];
  }

  /** Defaults to an already-existing `Maintenance` project so `ensureMaintenanceProjects` (SPEC §3.11) is a no-op unless a test overrides this. */
  async initiativeProjects(_initiativeId?: string): Promise<ProjectRef[]> {
    return [{ id: "maintenance-project", name: "Maintenance", status: null }];
  }

  async projectStatus(_projectId?: string): Promise<ProjectStatus | null> {
    return null;
  }

  async projectRelations(_projectId?: string): Promise<ProjectRelation[]> {
    return [];
  }

  async workflowStates(): Promise<WorkflowState[]> {
    return this.workflowStatesList;
  }

  async labels(): Promise<IssueLabel[]> {
    return [];
  }

  /** Defaults to one team keyed "ENG" so `reconcile`'s maintenance pass (SPEC §7.6a/§3.11) can resolve `entry.team` without every call site wiring a team fixture. */
  async teams(): Promise<TeamRef[]> {
    return [{ id: "team-1", key: "ENG", name: "Engineering" }];
  }

  async projects(): Promise<ProjectRef[]> {
    return [];
  }

  async viewerId(): Promise<string> {
    return "viewer-1";
  }

  async userByEmail(): Promise<never> {
    throw new Error("not implemented");
  }

  async updateIssue(id: string, input: IssueMutation): Promise<Issue> {
    this.updateCalls.push({ id, input });
    const issue = this.issuesById.get(id);
    if (!issue) throw new Error(`unknown issue id ${id}`);
    if (input.stateId) {
      const target = this.workflowStatesList.find((state) => state.id === input.stateId);
      if (target) issue.state = target;
    }
    if (input.removedLabelIds) {
      issue.labels = issue.labels.filter((label) => !input.removedLabelIds!.includes(label.id));
    }
    if (input.addedLabelIds) {
      for (const labelId of input.addedLabelIds) {
        if (!issue.labels.some((label) => label.id === labelId)) issue.labels.push({ id: labelId, name: labelId, parentId: null });
      }
    }
    return issue;
  }

  async createIssue(): Promise<Issue> {
    throw new Error("not implemented");
  }

  async createProject(): Promise<ProjectRef> {
    throw new Error("not implemented");
  }

  async addProjectToInitiative(): Promise<void> {
    throw new Error("not implemented");
  }

  async updateProjectStatus(): Promise<void> {
    throw new Error("not implemented");
  }

  async createComment(input: { issueId: string; body: string; parentId?: LinearId }): Promise<Comment> {
    this.commentCalls.push({ issueId: input.issueId, body: input.body });
    const comment: Comment = {
      id: `comment-${this.commentCalls.length}`,
      body: input.body,
      createdAt: new Date().toISOString(),
      user: { id: "viewer-1", name: "viewer-1", displayName: "viewer-1" },
      parentId: input.parentId ?? null,
    };
    const issue = this.issuesById.get(input.issueId);
    if (issue) issue.comments = [...issue.comments, comment];
    return comment;
  }

  async createRelation(): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteRelation(): Promise<void> {
    throw new Error("not implemented");
  }

  async createProjectRelation(): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteProjectRelation(): Promise<void> {
    throw new Error("not implemented");
  }

  async createLabel(): Promise<IssueLabel> {
    throw new Error("not implemented");
  }

  async ensureLabel(name: string): Promise<IssueLabel> {
    return { id: name, name, parentId: null };
  }
}

export type { IssueFilter, IssueRelationType, CreateIssueInput, ProjectStatusType };
